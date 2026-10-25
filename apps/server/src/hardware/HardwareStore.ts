/**
 * Leases outlive turns and restarts, so a failed lease write fails the operation rather than
 * leaving memory and disk disagreeing about who holds a device. Only the audit trail is best-effort.
 */
import {
  HardwareActionDefinition,
  type HardwareAuditEntry,
  type HardwareAuditEvent,
  type HardwareDeviceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** Events whose repeats collapse into one row. */
const COALESCED_EVENTS: ReadonlySet<HardwareAuditEvent> = new Set(["call", "hook"]);
const AUDIT_RETENTION_DAYS = 90;
const AUDIT_MAX_ROWS = 10_000;

/**
 * What ending a lease runs: the accepted release hooks resolved against the
 * device as it was configured, so cleanup still works after the device is
 * edited or removed, or the server restarts mid-cleanup.
 */
export const ReleasePlan = Schema.Struct({
  baseUrl: Schema.String,
  /** Secret-store name of the credential copied at grant, so cleanup never sends a newer one. */
  credentialSecret: Schema.optional(Schema.String),
  auth: Schema.optional(
    Schema.Struct({
      header: Schema.optional(Schema.String),
      scheme: Schema.optional(Schema.String),
    }),
  ),
  steps: Schema.Array(
    Schema.Struct({
      action: Schema.String,
      definition: HardwareActionDefinition,
      query: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
    }),
  ),
});
export type ReleasePlan = typeof ReleasePlan.Type;
const ReleasePlanJson = Schema.fromJsonString(ReleasePlan);
const decodeReleasePlan = Schema.decodeUnknownOption(ReleasePlanJson);
const encodeReleasePlan = Schema.encodeSync(ReleasePlanJson);
const EMPTY_PLAN: ReleasePlan = { baseUrl: "", steps: [] };

export class HardwareStoreError extends Schema.TaggedError<HardwareStoreError>()(
  "HardwareStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Hardware lease ${this.operation} failed.`;
  }
}

export interface StoredLease {
  readonly deviceId: HardwareDeviceId;
  readonly threadId: ThreadId;
  readonly purpose: string;
  readonly token: string;
  readonly grantedAt: number;
  readonly lastActivityAt: number;
  readonly idleMinutes: number;
  readonly hardExpiresAt: number | null;
  readonly keepUntilReleased: boolean;
  readonly releasePlan: ReleasePlan;
  /** Set once the lease ended: cleanup retries until then, after which it gives up. */
  readonly releasingUntil: number | null;
}

export interface AuditRecord {
  readonly deviceId: HardwareDeviceId;
  readonly actor: "thread" | "user" | "system";
  readonly threadId: ThreadId | null;
  readonly event: HardwareAuditEvent;
  readonly action?: string | undefined;
  readonly detail?: Readonly<Record<string, unknown>> | undefined;
}

export class HardwareStore extends Context.Service<
  HardwareStore,
  {
    readonly loadLeases: Effect.Effect<ReadonlyArray<StoredLease>, HardwareStoreError>;
    readonly saveLease: (lease: StoredLease) => Effect.Effect<void, HardwareStoreError>;
    readonly deleteLease: (deviceId: HardwareDeviceId) => Effect.Effect<void, HardwareStoreError>;
    readonly audit: (record: AuditRecord) => Effect.Effect<void>;
    readonly listAudit: (
      deviceId: HardwareDeviceId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<HardwareAuditEntry>>;
    readonly pruneAudit: Effect.Effect<void>;
  }
>()("@styal/cli/hardware/HardwareStore") {}

interface LeaseRow {
  readonly deviceId: string;
  readonly threadId: string;
  readonly purpose: string;
  readonly token: string;
  readonly grantedAt: string;
  readonly lastActivityAt: string;
  readonly idleMinutes: number;
  readonly hardExpiresAt: string | null;
  readonly keepUntilReleased: number;
  readonly releasePlanJson: string;
  readonly releasingUntil: string | null;
}

interface AuditRow {
  readonly id: number;
  readonly deviceId: string;
  readonly occurredAt: string;
  readonly lastOccurredAt: string;
  readonly actor: string;
  readonly threadId: string | null;
  readonly event: string;
  readonly action: string | null;
  readonly detailJson: string;
  readonly repeatCount: number;
}

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const ms = (value: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(value));

const DetailJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeDetail = Schema.decodeUnknownOption(DetailJson);
const encodeDetail = Schema.encodeSync(DetailJson);
const parseDetail = (json: string): Record<string, unknown> =>
  Option.getOrElse(decodeDetail(json), () => ({}));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The audit trail is best-effort: a failed write is logged, never fatal to a call.
  const logged = <A, E>(operation: string, effect: Effect.Effect<A, E>, fallback: A) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`Hardware store ${operation} failed`, { cause }).pipe(
          Effect.as(fallback),
        ),
      ),
    );

  const failed =
    (operation: string) =>
    <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, HardwareStoreError> =>
      effect.pipe(Effect.mapError((cause) => new HardwareStoreError({ operation, cause })));

  const loadLeases = sql<LeaseRow>`
    SELECT device_id AS "deviceId", thread_id AS "threadId", purpose, token,
      granted_at AS "grantedAt", last_activity_at AS "lastActivityAt",
      idle_minutes AS "idleMinutes", hard_expires_at AS "hardExpiresAt",
      keep_until_released AS "keepUntilReleased", release_plan_json AS "releasePlanJson",
      releasing_until AS "releasingUntil"
    FROM hardware_leases
  `.pipe(
    Effect.map((rows) =>
      rows.map((row): StoredLease => ({
        deviceId: row.deviceId as HardwareDeviceId,
        threadId: ThreadId.make(row.threadId),
        purpose: row.purpose,
        token: row.token,
        grantedAt: ms(row.grantedAt),
        lastActivityAt: ms(row.lastActivityAt),
        idleMinutes: row.idleMinutes,
        hardExpiresAt: row.hardExpiresAt === null ? null : ms(row.hardExpiresAt),
        keepUntilReleased: row.keepUntilReleased === 1,
        releasePlan: Option.getOrElse(decodeReleasePlan(row.releasePlanJson), () => EMPTY_PLAN),
        releasingUntil: row.releasingUntil === null ? null : ms(row.releasingUntil),
      })),
    ),
    failed("load"),
  );

  const saveLease = (lease: StoredLease) =>
    sql`
      INSERT INTO hardware_leases (
        device_id, thread_id, purpose, token, granted_at, last_activity_at,
        idle_minutes, hard_expires_at, keep_until_released, release_plan_json, releasing_until
      ) VALUES (
        ${lease.deviceId}, ${lease.threadId}, ${lease.purpose}, ${lease.token},
        ${iso(lease.grantedAt)}, ${iso(lease.lastActivityAt)}, ${lease.idleMinutes},
        ${lease.hardExpiresAt === null ? null : iso(lease.hardExpiresAt)},
        ${lease.keepUntilReleased ? 1 : 0}, ${encodeReleasePlan(lease.releasePlan)},
        ${lease.releasingUntil === null ? null : iso(lease.releasingUntil)}
      )
      ON CONFLICT (device_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        purpose = excluded.purpose,
        token = excluded.token,
        granted_at = excluded.granted_at,
        last_activity_at = excluded.last_activity_at,
        idle_minutes = excluded.idle_minutes,
        hard_expires_at = excluded.hard_expires_at,
        keep_until_released = excluded.keep_until_released,
        release_plan_json = excluded.release_plan_json,
        releasing_until = excluded.releasing_until
    `.pipe(Effect.asVoid, failed("save"));

  const deleteLease = (deviceId: HardwareDeviceId) =>
    sql`DELETE FROM hardware_leases WHERE device_id = ${deviceId}`.pipe(
      Effect.asVoid,
      failed("delete"),
    );

  const audit = (record: AuditRecord) =>
    logged(
      "audit write",
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const detailJson = encodeDetail({ ...record.detail });
        const action = record.action ?? null;
        if (COALESCED_EVENTS.has(record.event)) {
          const latest = yield* sql<{
            readonly id: number;
            readonly event: string;
            readonly action: string | null;
            readonly actor: string;
            readonly threadId: string | null;
          }>`
            SELECT id, event, action, actor, thread_id AS "threadId"
            FROM hardware_audit_events
            WHERE device_id = ${record.deviceId}
            ORDER BY id DESC LIMIT 1
          `;
          const last = latest[0];
          if (
            last !== undefined &&
            last.event === record.event &&
            last.action === action &&
            last.actor === record.actor &&
            last.threadId === record.threadId
          ) {
            yield* sql`
              UPDATE hardware_audit_events
              SET repeat_count = repeat_count + 1, last_occurred_at = ${now}, detail_json = ${detailJson}
              WHERE id = ${last.id}
            `;
            return;
          }
        }
        yield* sql`
          INSERT INTO hardware_audit_events (
            device_id, occurred_at, last_occurred_at, actor, thread_id, event, action, detail_json
          ) VALUES (
            ${record.deviceId}, ${now}, ${now}, ${record.actor}, ${record.threadId},
            ${record.event}, ${action}, ${detailJson}
          )
        `;
      }),
      undefined,
    );

  const listAudit = (deviceId: HardwareDeviceId, limit: number) =>
    logged(
      "audit read",
      sql<AuditRow>`
        SELECT id, device_id AS "deviceId", occurred_at AS "occurredAt",
          last_occurred_at AS "lastOccurredAt", actor, thread_id AS "threadId", event, action,
          detail_json AS "detailJson", repeat_count AS "repeatCount"
        FROM hardware_audit_events
        WHERE device_id = ${deviceId}
        ORDER BY id DESC LIMIT ${limit}
      `.pipe(
        Effect.map((rows) =>
          rows.map((row): HardwareAuditEntry => ({
            id: row.id,
            deviceId: row.deviceId as HardwareDeviceId,
            occurredAt: row.occurredAt,
            lastOccurredAt: row.lastOccurredAt,
            actor: row.actor as HardwareAuditEntry["actor"],
            threadId: row.threadId === null ? null : ThreadId.make(row.threadId),
            event: row.event as HardwareAuditEvent,
            action: row.action,
            detail: parseDetail(row.detailJson),
            repeatCount: row.repeatCount,
          })),
        ),
      ),
      [] as ReadonlyArray<HardwareAuditEntry>,
    );

  const pruneAudit = logged(
    "audit prune",
    Effect.gen(function* () {
      const cutoff = DateTime.formatIso(
        DateTime.subtract(yield* DateTime.now, { days: AUDIT_RETENTION_DAYS }),
      );
      yield* sql`DELETE FROM hardware_audit_events WHERE last_occurred_at < ${cutoff}`;
      yield* sql`
        DELETE FROM hardware_audit_events
        WHERE id <= (
          SELECT id FROM hardware_audit_events ORDER BY id DESC LIMIT 1 OFFSET ${AUDIT_MAX_ROWS}
        )
      `;
    }),
    undefined,
  );

  return HardwareStore.of({ loadLeases, saveLease, deleteLease, audit, listAudit, pruneAudit });
});

export const layer = Layer.effect(HardwareStore, make);
