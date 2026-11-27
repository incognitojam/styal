// @effect-diagnostics nodeBuiltinImport:off - Standalone offline maintenance boundary.
// @effect-diagnostics globalJsonInEffect:off - Raw JSON is inspected at this privacy boundary; failures never leave it.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as C from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Issue from "effect/SchemaIssue";
import * as SqlClient from "effect/sql/SqlClient";
import { SqlError } from "effect/sql/SqlError";
import {
  makeReadApplicationRows,
  rowToApplicationStoredEvent,
} from "../OrchestrationEventStore.ts";
import { columnCodecs, projectionCodecs, schemaKeys } from "./codecs.ts";
import {
  backgroundCommand,
  historicalPayloads,
  removedFields,
  serverCapability,
} from "./preflightKnown.ts";
import { OrchestrationEffectRequestV2 } from "../../orchestration-v2/EffectOutbox.ts";
import { ProjectDbRow } from "../../orchestration-v2/ProjectStore.ts";
import source from "./source.json" with { type: "json" };
import { compareSchema, schemaHash } from "./schema.ts";

export class PreflightRefusal extends Schema.TaggedError<PreflightRefusal>()("PreflightRefusal", {
  category: Schema.String,
}) {
  override get message() {
    return this.category;
  }
}
const inside = (file: string, home: string) =>
  file === home || file.startsWith(home + NodePath.sep);
function canonical(path: string, depth = 0): string {
  if (depth > 40) throw new PreflightRefusal({ category: "source-path-resolution-failed" });
  try {
    if (NodeFS.lstatSync(path).isSymbolicLink())
      return canonical(
        NodePath.resolve(NodePath.dirname(path), NodeFS.readlinkSync(path)),
        depth + 1,
      );
    return NodeFS.realpathSync(path);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw new PreflightRefusal({ category: "source-path-resolution-failed" });
    const parent = NodePath.dirname(path);
    return parent === path
      ? path
      : NodePath.join(canonical(parent, depth + 1), NodePath.basename(path));
  }
}
export function assertOffline(path: string) {
  const file = canonical(NodePath.resolve(path));
  const homes = [
    NodePath.join(NodeOS.homedir(), ".styal"),
    NodePath.join(NodeOS.userInfo().homedir, ".styal"),
    process.env.STYAL_HOME,
  ].filter((v): v is string => Boolean(v));
  if (homes.some((home) => inside(file, canonical(NodePath.resolve(home)))))
    throw new PreflightRefusal({ category: "live-styal-home-refused" });
  if (NodeFS.existsSync(file)) {
    const stat = NodeFS.statSync(file);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new PreflightRefusal({ category: "regular-single-link-database-required" });
  }
  return file;
}
function parse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
const keys = new Set(source.keys);
for (const codec of [
  ...Object.values(projectionCodecs),
  ...Object.values(columnCodecs),
  C.OrchestrationV2DomainEventJson,
  C.ApplicationProjectEvent,
  ...Object.values(historicalPayloads),
  backgroundCommand,
])
  schemaKeys(codec.ast, keys);
const field = (key: PropertyKey) =>
  typeof key === "number"
    ? "[]"
    : typeof key === "string" && keys.has(key)
      ? key
      : "unrecognised-field";
const safePath = (path: readonly PropertyKey[]) => (path.length ? path.map(field).join(".") : "$");
const bump = (counts: Record<string, number>, key: string, n = 1) => {
  counts[key] = (counts[key] ?? 0) + n;
};
const states = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "succeeded",
  "cancelled",
  "rolled_back",
  "pending",
  "superseded",
  "idle",
  "ready",
  "draft",
  "stale",
  "stopped",
  "error",
  "not_loaded",
  "active",
  "archived",
  "closed",
  "resolved",
  "expired",
  "resolved_native",
  "resolved_portable",
  "consumed",
  "captured",
  "missing",
  "ended",
  "rejected",
  "attached",
  "dispatched",
  "processing",
  "delivered",
]);
const markers = [
  "snoozedUntil",
  "limitRecovery",
  "delegatedCompletion",
  "titleRegeneration",
  "rollbackRequestId",
  "steerWhenReadyRunId",
  "restartHeldRunIds",
  "queueHeld",
  "pendingBackgroundTasks",
  "authRecovery",
  "delegatedFrom",
  "workflowRun",
  "goal",
];
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
type Counts = {
  rows: number;
  derived?: "virtual" | "shadow";
  storedBytes?: number;
  scanSkipped?: "unsafe-integer";
  rejected: number;
  failures: Record<string, number>;
  unknownFields: Record<string, number>;
  unexpected: number;
};
function issues(
  issue: Issue.Issue,
  visit: (path: readonly PropertyKey[], tag: string) => void,
  path: readonly PropertyKey[] = [],
) {
  if (issue._tag === "Pointer") return issues(issue.issue, visit, [...path, ...issue.path]);
  if ("issues" in issue && issue.issues.length) {
    for (const child of issue.issues) issues(child, visit, path);
    return;
  }
  if ("issue" in issue) {
    issues(issue.issue, visit, path);
    return;
  }
  visit(path, issue._tag);
}
const isServerCapability = Schema.is(serverCapability);
const isBackgroundCommand = Schema.is(backgroundCommand);
const eventMembers = C.OrchestrationV2DomainEventJson.members.map((codec) => ({
  codec,
  isKind: Schema.is(codec.fields.type),
}));
function eventKind(type: string) {
  return C.isKnownOrchestrationV2EventType(type) ||
    Object.hasOwn(historicalPayloads, type) ||
    ["project.created", "project.meta-updated", "project.deleted"].includes(type)
    ? type
    : "unrecognised-event-kind";
}
const eventHeader = C.OrchestrationV2StoredEvent.mapFields(({ sequence, commandId }) => ({
  sequence,
  commandId,
}));
const eventEnvelope = C.OrchestrationV2DomainEventJson.members[0].mapFields(
  ({ type: _type, payload: _payload, ...fields }) => fields,
);
const sourceEffectKinds = new Set([
  "thread-report.check",
  "message.mentioned-times.check",
  "delegated-task.wake-timeout",
]);
const effectKinds = OrchestrationEffectRequestV2.members.map((codec) =>
  Schema.is(codec.fields.type),
);
const strict = { errors: "all", onExcessProperty: "error" } as const;
function diagnose(
  codec: Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never },
  value: unknown,
) {
  const failures: { path: readonly PropertyKey[]; tag: string }[] = [];
  const decoded = Schema.decodeUnknownResult(codec, strict)(value);
  if (Result.isFailure(decoded))
    issues(decoded.failure.issue, (path, tag) => failures.push({ path, tag }));
  return failures;
}
function knownUnknown(record: string, path: readonly PropertyKey[]) {
  const name = safePath(path);
  return (removedFields[record] ?? []).some(
    (known) => name === known || name.startsWith(known + "."),
  );
}
function compatibility(value: unknown, path: readonly PropertyKey[] = []): unknown {
  if (Array.isArray(value)) return value.map((v, i) => compatibility(v, [...path, i]));
  if (!object(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === "responseCapability" && object(v) && v.type === "server" && isServerCapability(v))
      out[key] = { type: "message" };
    else if (key === "command" && path.includes("pendingBackgroundTasks") && isBackgroundCommand(v))
      out[key] = "historical-command";
    else if (
      key === "icon" &&
      path.includes("scripts") &&
      typeof v === "string" &&
      ["desktop", "database", "deploy"].includes(v)
    )
      out[key] = "play";
    else if (key === "scripts" && typeof v === "string") {
      const scripts = parse(v);
      out[key] = scripts === undefined ? v : JSON.stringify(compatibility(scripts, [...path, key]));
    } else out[key] = compatibility(v, [...path, key]);
  }
  return out;
}
function inspect(
  counts: Counts,
  codec: Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never },
  value: unknown,
  record: string,
  kind = record,
) {
  const failures = diagnose(codec, value);
  const historicalFields = (v: unknown, path: readonly PropertyKey[] = [], depth = 0) => {
    if (depth > 32) {
      counts.unexpected++;
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((child, i) => historicalFields(child, [...path, i], depth + 1));
      return;
    }
    if (!object(v)) return;
    for (const [key, child] of Object.entries(v)) {
      const shape =
        key === "responseCapability" && object(child) && child.type === "server"
          ? serverCapability
          : key === "command" && path.includes("pendingBackgroundTasks") && object(child)
            ? backgroundCommand
            : undefined;
      if (shape)
        for (const failure of diagnose(shape, child))
          failures.push({ ...failure, path: [...path, key, ...failure.path] });
      historicalFields(child, [...path, key], depth + 1);
    }
  };
  historicalFields(value);
  const seen = new Set<string>();
  for (const failure of failures.filter((f) => f.tag === "UnexpectedKey")) {
    const path = safePath(failure.path);
    if (!seen.has(path)) {
      bump(counts.unknownFields, `${kind} / ${path}`);
      seen.add(path);
    }
    if (!knownUnknown(record, failure.path[0] === "payload" ? failure.path.slice(1) : failure.path))
      counts.unexpected++;
    let subtree: unknown = value;
    for (const key of failure.path)
      subtree =
        object(subtree) || Array.isArray(subtree)
          ? (subtree as Record<PropertyKey, unknown>)[key]
          : undefined;
    const nested = (v: unknown, path: readonly PropertyKey[], depth: number) => {
      if (depth > 32) {
        counts.unexpected++;
        return;
      }
      if (Array.isArray(v)) {
        for (const child of v) nested(child, [...path, 0], depth + 1);
      } else if (object(v))
        for (const [key, child] of Object.entries(v)) {
          const name = safePath([...path, key]);
          if (!seen.has(name)) {
            bump(counts.unknownFields, `${kind} / ${name}`);
            seen.add(name);
          }

          nested(child, [...path, key], depth + 1);
        }
    };
    nested(subtree, failure.path, 0);
  }
  const result = Schema.decodeUnknownResult(codec, { errors: "all" })(value);
  if (Result.isFailure(result)) {
    counts.rejected++;
    const paths = new Set<string>();
    issues(result.failure.issue, (path) => paths.add(safePath(path)));
    for (const path of paths) bump(counts.failures, `${kind} / ${path}`);
    const fixed = Schema.decodeUnknownResult(codec)(compatibility(value));
    if (Result.isFailure(fixed)) counts.unexpected++;
  } else {
    const encoded = Schema.encodeUnknownResult(codec)(result.success);
    if (Result.isSuccess(encoded)) {
      const compare = (
        before: unknown,
        after: unknown,
        path: readonly PropertyKey[] = [],
        depth = 0,
      ) => {
        if (depth > 32) {
          counts.unexpected++;
          return;
        }
        if (Array.isArray(before) && Array.isArray(after))
          before.forEach((v, i) => compare(v, after[i], [...path, i], depth + 1));
        else if (object(before) && object(after))
          for (const [key, child] of Object.entries(before)) {
            const at = [...path, key],
              name = safePath(at);
            if (!Object.hasOwn(after, key)) {
              if (!seen.has(name)) {
                bump(counts.unknownFields, `${kind} / ${name}`);
                seen.add(name);
                if (!knownUnknown(record, at[0] === "payload" ? at.slice(1) : at))
                  counts.unexpected++;
              }
            } else compare(child, after[key], at, depth + 1);
          }
      };
      compare(value, encoded.success);
    }
  }
}

function mainRevision(filename: string) {
  try {
    const stat = NodeFS.statSync(filename, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch {
    throw new PreflightRefusal({
      category: "read-only-source-unavailable-use-snapshot-with-sidecars-or-writable-copy",
    });
  }
}
function sidecars(filename: string) {
  const read = (suffix: string) => {
    const path = assertOffline(filename + suffix);
    try {
      const stat = NodeFS.statSync(path, { bigint: true });
      return {
        exists: true,
        size: Number(stat.size),
        revision: `${stat.dev}:${stat.ino}:${stat.mtimeNs}`,
      };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return { exists: false, size: 0, revision: "" };
      throw new PreflightRefusal({ category: "sidecar-stat-failed" });
    }
  };
  return { wal: read("-wal"), shm: read("-shm") };
}
function sidecarFacts(value: ReturnType<typeof sidecars>) {
  return {
    wal: { exists: value.wal.exists, size: value.wal.size },
    shm: { exists: value.shm.exists, size: value.shm.size },
  };
}
const isSqlError = Schema.is(SqlError);

export const preflight = Effect.fn("DataMove.preflight")(function* (
  path: string,
  progress: (line: string) => void = () => {},
) {
  const filename = yield* Effect.sync(() => assertOffline(path));
  const mainBefore = yield* Effect.sync(() => mainRevision(filename));
  const before = yield* Effect.sync(() => {
    assertOffline(filename + "-journal");
    return sidecars(filename);
  });
  const report = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA query_only=ON");
    yield* sql.unsafe("PRAGMA trusted_schema=OFF");
    yield* sql.unsafe("PRAGMA cache_size=-16384");
    yield* sql.unsafe("PRAGMA threads=1");
    const started = performance.now();
    const now = yield* Clock.currentTimeMillis;
    const definitions = (yield* sql.unsafe<{
      name: string;
      type: string;
      tbl_name: string;
      sql: string;
    }>("SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL"));
    const differences = compareSchema(
      definitions.map((d) => ({ ...d, table: d.tbl_name, hash: schemaHash(d.sql) })),
      source.definitions,
    );
    const tableKinds = new Map(
      (yield* sql.unsafe<{ name: string; type: string; wr: number }>(
        "SELECT name,type,wr FROM pragma_table_list WHERE schema='main'",
      )).map((table) => [table.name, table]),
    );
    const ledgers: Record<string, { missing: number[]; extra: number[]; renamed: number[] }> = {};
    for (const [table, expected] of [
      ["effect_sql_migrations", source.ledger],
      ["yngatech_sql_migrations", source.forkLedger],
    ] as const) {
      const definition = definitions.find((d) => d.name === table && d.type === "table");
      const expectedDefinition = source.definitions.find((d) => d.name === table)!;
      const matches =
        definition &&
        NodeCrypto.createHash("sha256").update(JSON.stringify(definition.sql)).digest("hex") ===
          expectedDefinition.hash;
      const rows = matches
        ? yield* sql.unsafe<{ migration_id: number; name: string }>(
            `SELECT migration_id,name FROM ${q(table)} WHERE migration_id BETWEEN -9007199254740991 AND 9007199254740991`,
          )
        : [];
      ledgers[table] = {
        missing: expected
          .filter((e) => !rows.some((r) => r.migration_id === e.migration_id))
          .map((e) => e.migration_id),
        extra: rows
          .filter((r) => !expected.some((e) => e.migration_id === r.migration_id))
          .map((r) => r.migration_id),
        renamed: rows
          .filter((r) =>
            expected.some((e) => e.migration_id === r.migration_id && e.name !== r.name),
          )
          .map((r) => r.migration_id),
      };
    }
    for (const expected of source.definitions) {
      const actual = definitions.find((d) => d.name === expected.name);
      if (expected.type === "table" && actual) {
        const columns = yield* sql.unsafe<Record<string, unknown>>(
          `PRAGMA table_xinfo(${q(expected.name)})`,
        );
        const variant =
          "variants" in expected
            ? expected.variants?.find((v) => v.hash === schemaHash(actual.sql))
            : undefined;
        const pinnedColumns = variant?.columns ?? expected.columns;
        for (const column of pinnedColumns) {
          const found = columns.find((c) => c.name === column.name);
          if (!found || JSON.stringify(found) !== JSON.stringify(column))
            bump(differences, `column / ${expected.name}.${column.name} / changed`);
        }
        const known = new Set(pinnedColumns.map((c) => c.name));
        for (const column of columns)
          if (!known.has(String(column.name)))
            bump(differences, `column / ${expected.name} / unrecognised-column`);
      }
    }
    const timing: Record<string, number> = { catalog: performance.now() - started };
    const tables: Record<string, Counts> = {};
    const census: Record<string, number> = {};
    let unexpected =
      Object.keys(differences).length +
      Object.values(ledgers).reduce(
        (n, l) => n + l.missing.length + l.extra.length + l.renamed.length,
        0,
      );
    const globals: Record<string, number> = {};
    // Do not execute reader SQL against a schema the pinned source never supplied.
    if (Object.keys(differences).length === 0) {
      const scanStarted = performance.now();
      for (const definition of source.definitions.filter((d) => d.type === "table")) {
        const table = definition.name;
        if (!tableKinds.has(table)) continue;
        const counts: Counts = {
          rows: 0,
          rejected: 0,
          failures: {},
          unknownFields: {},
          unexpected: 0,
        };
        tables[table] = counts;
        const at = performance.now();
        const record = table.replace("orchestration_v2_projection_", "");
        const codec = projectionCodecs[record as keyof typeof projectionCodecs];
        const kind = tableKinds.get(table)!;
        const derived = kind.type === "virtual" || kind.type === "shadow";
        const integerColumns = definition.columns.map((column) => column.name);
        const primaryKey = definition.columns.filter((column) => column.pk);
        if (
          !derived &&
          kind.wr === 0 &&
          !(primaryKey.length === 1 && primaryKey[0]!.type.toUpperCase() === "INTEGER")
        )
          integerColumns.push("rowid");
        const unsafe = derived
          ? undefined
          : (yield* sql.unsafe<Record<string, number>>(
              `SELECT count(*) AS __rows,${integerColumns
                .map(
                  (column, index) =>
                    `coalesce(sum(CASE WHEN typeof(${q(column)})='integer' AND (${q(column)}>9007199254740991 OR ${q(column)}< -9007199254740991) THEN 1 ELSE 0 END),0) AS ${q("unsafe_" + index)}`,
                )
                .join(",")} FROM ${q(table)}`,
            ))[0]!;
        for (const [index, column] of integerColumns.entries()) {
          const count = unsafe?.["unsafe_" + index] ?? 0;
          if (count) {
            globals[`unsafe-integer / ${table} / ${column}`] = count;
            counts.unexpected += count;
          }
        }
        // FTS tombstone IDs exceed JS's safe range; only SQLite inspects derived contents.
        if (derived) {
          const lengths = definition.columns
            .filter((column) => column.hidden === 0)
            .map((column) => `coalesce(length(CAST(${q(column.name)} AS BLOB)),0)`);
          const totals = (yield* sql.unsafe<{ rows: number; bytes: number }>(
            `SELECT count(*) AS rows,coalesce(sum(${lengths.join("+") || "0"}),0) AS bytes FROM ${q(table)}`,
          ))[0]!;
          counts.rows = totals.rows;
          counts.derived = kind.type as "virtual" | "shadow";
          counts.storedBytes = totals.bytes;
        } else if (counts.unexpected) {
          counts.rows = unsafe!.__rows!;
          counts.scanSkipped = "unsafe-integer";
        } else if ("optional" in definition && definition.optional) {
          const [total] = yield* sql.unsafe<{ n: number }>(`SELECT count(*) n FROM ${q(table)}`);
          counts.rows = total!.n;
        } else if (table === "orchestration_events") {
          // Use the runtime query, including retained prompt anchors.
          const read = makeReadApplicationRows(sql);
          let cursor = 0;
          for (;;) {
            const page = yield* read({ afterSequence: cursor, limit: 128 }).pipe(Effect.result);
            const rows = Result.isSuccess(page) ? [...page.success] : [];
            let pageSize = rows.length,
              nextCursor = rows.at(-1)?.sequence ?? cursor;
            if (Result.isFailure(page)) {
              // A malformed compacted payload can fail SQL hydration before decoding the page.
              const headers = yield* sql.unsafe<{ sequence: number; event_type: string }>(
                "SELECT sequence,event_type FROM orchestration_events WHERE sequence>? AND (aggregate_kind='project' OR (application_event_version=2 AND aggregate_kind='thread')) ORDER BY sequence LIMIT 128",
                [cursor],
              );
              pageSize = headers.length;
              nextCursor = headers.at(-1)?.sequence ?? cursor;
              for (const header of headers) {
                const single = yield* read({
                  afterSequence: header.sequence - 1,
                  throughSequence: header.sequence,
                  limit: 1,
                }).pipe(Effect.result);
                if (Result.isSuccess(single)) rows.push(...single.success);
                else {
                  counts.rows++;
                  counts.rejected++;
                  counts.unexpected++;
                  bump(counts.failures, `${eventKind(header.event_type)} / payload_json`);
                }
              }
            }
            for (const row of rows) {
              counts.rows++;
              const kind = eventKind(row.event_type);
              const failurePaths = new Set<string>();
              const decoded = yield* rowToApplicationStoredEvent(row).pipe(Effect.result);
              if (Result.isFailure(decoded)) {
                counts.rejected++;
                const paths = new Set<string>();
                issues(decoded.failure.issue, (path) => {
                  if (
                    path.length === 1 &&
                    path[0] === "type" &&
                    C.isKnownOrchestrationV2EventType(row.event_type)
                  )
                    return;
                  paths.add(safePath(path));
                });
                for (const path of paths) {
                  const key = `${kind} / ${path}`;
                  failurePaths.add(key);
                  bump(counts.failures, key);
                }
              }
              const payload = parse(row.payload_json),
                metadata = parse(row.metadata_json);
              if (payload === undefined || metadata === undefined) {
                counts.unexpected++;
                bump(counts.failures, `${kind} / invalid-json`);
                continue;
              }

              const historical = Object.hasOwn(historicalPayloads, row.event_type)
                ? historicalPayloads[row.event_type as keyof typeof historicalPayloads]
                : undefined;
              const diagnostic: Counts = {
                rows: 0,
                rejected: 0,
                failures: {},
                unknownFields: {},
                unexpected: 0,
              };
              if (row.aggregate_kind === "thread") {
                const values = object(metadata) ? metadata : {};
                const envelope = {
                  id: row.event_id,
                  threadId: row.stream_id,
                  occurredAt: row.occurred_at,
                  ...Object.fromEntries(
                    ["runId", "nodeId", "driver", "providerInstanceId", "rawEventId"]
                      .filter((key) => values[key] !== undefined)
                      .map((key) => [key, values[key]]),
                  ),
                };
                inspect(
                  diagnostic,
                  eventHeader,
                  { sequence: row.sequence, commandId: row.command_id },
                  "header",
                  kind,
                );
                inspect(diagnostic, eventEnvelope, envelope, "header", kind);
                inspect(diagnostic, C.ApplicationEventMetadata, metadata, "metadata", kind);
                if (historical) {
                  inspect(diagnostic, historical, payload, "historical", kind);
                } else {
                  const event = { ...envelope, type: row.event_type, payload };
                  const payloadKind =
                    row.event_type === "thread.created"
                      ? "threads"
                      : typeof row.event_type === "string"
                        ? row.event_type.split(".")[0]!.replaceAll("-", "_") + "s"
                        : "events";
                  const member = eventMembers.find((m) => m.isKind(row.event_type))?.codec;
                  inspect(
                    diagnostic,
                    member ?? C.OrchestrationV2DomainEventJson,
                    event,
                    payloadKind,
                    kind,
                  );
                }
              } else {
                inspect(
                  diagnostic,
                  C.ApplicationProjectEvent,
                  {
                    sequence: row.sequence,
                    eventId: row.event_id,
                    type: row.event_type,
                    aggregateKind: row.aggregate_kind,
                    aggregateId: row.stream_id,
                    occurredAt: row.occurred_at,
                    commandId: row.command_id,
                    causationEventId: row.causation_event_id,
                    correlationId: row.correlation_id,
                    payload,
                    metadata,
                  },
                  "projects",
                  kind,
                );
              }
              for (const [key, n] of Object.entries(diagnostic.unknownFields))
                bump(counts.unknownFields, key, n);
              for (const key of Object.keys(diagnostic.failures))
                if (!failurePaths.has(key)) bump(counts.failures, key);
              counts.unexpected += diagnostic.unexpected;
              if (Result.isFailure(decoded) && diagnostic.rejected === 0 && !historical)
                counts.unexpected++;
            }
            if (pageSize < 128) break;
            cursor = nextCursor;
          }
        } else {
          const withoutRowid = definitions
            .find((d) => d.name === table)!
            .sql.includes("WITHOUT ROWID");
          const pk = withoutRowid
            ? definition.columns
                .filter((c) => c.pk)
                .sort((a, b) => a.pk - b.pk)
                .map((c) => c.name)
            : ["rowid"];
          let cursor: (string | number | bigint | Uint8Array | null)[] | undefined;
          for (;;) {
            const rows = yield* sql.unsafe<Record<string, unknown>>(
              `SELECT ${withoutRowid ? "" : "rowid AS __cursor,"}* FROM ${q(table)} ${cursor ? `WHERE (${pk.map(q).join(",")})>(${pk.map(() => "?").join(",")})` : ""} ORDER BY ${pk.map(q).join(",")} LIMIT 128`,
              cursor,
            );
            for (const row of rows) {
              counts.rows++;
              const rejectedBefore = counts.rejected;
              if (table === "orchestration_v2_effect_outbox") {
                const effect =
                  effectKinds.some((isKind) => isKind(row.effect_type)) ||
                  sourceEffectKinds.has(String(row.effect_type));
                if (!effect) counts.unexpected++;
                bump(
                  census,
                  `${table} / ${effect ? String(row.effect_type) : "unrecognised-effect"} / ${states.has(String(row.status)) ? String(row.status) : "unrecognised-state"}`,
                );
              }
              if (table === "orchestration_v2_projection_metadata") {
                const name = [
                  "thread-projections",
                  "event-log-pruned-through",
                  "event-log-prune-mark",
                ].includes(String(row.projection_name))
                  ? String(row.projection_name)
                  : "unrecognised-projection";
                globals[`${name} / schema-version`] = Number(row.schema_version);
                globals[`${name} / cursor`] = Number(row.last_sequence);
                if (name === "unrecognised-projection") counts.unexpected++;
              }
              if (row.state !== undefined)
                bump(
                  census,
                  `${table} / state / ${states.has(String(row.state)) ? String(row.state) : "unrecognised-state"}`,
                );
              if (row.status !== undefined && !states.has(String(row.status))) counts.unexpected++;
              if (row.status !== undefined)
                bump(
                  census,
                  `${table} / status / ${states.has(String(row.status)) ? String(row.status) : "unrecognised-state"}`,
                );
              for (const key of [
                "enabled",
                "binding_json",
                "resume_key_json",
                "resume_cursor_json",
                "snoozed_until",
                "title_regeneration_request_id",
                "title_regeneration_started_at",
              ])
                if (row[key]) bump(census, `${table} / ${key}`);
              if (
                ["auth_sessions", "auth_pairing_links", "peer_environment_links"].includes(table)
              ) {
                const expires = Date.parse(String(row.expires_at));
                const age = expires > now ? "unexpired" : "expired-or-invalid";
                bump(census, `${table} / ${age}`);
                if (row.revoked_at) bump(census, `${table} / revoked_at`);
                if (row.consumed_at) bump(census, `${table} / consumed_at`);
              }
              if (table === "projection_projects") {
                inspect(
                  counts,
                  ProjectDbRow,
                  {
                    projectId: row.project_id,
                    title: row.title,
                    hasCustomTitle: 0,
                    workspaceRoot: row.workspace_root,
                    defaultModelSelection: row.default_model_selection_json,
                    defaultThreadEnvMode: row.default_thread_env_mode,
                    autoPull: row.auto_pull,
                    faviconPath: row.favicon_path,
                    additionalInstructions: row.additional_instructions,
                    projectIcon: row.project_icon_json,
                    scripts: row.scripts_json,
                    trackedFolders: "[]",
                    pinnedAt: row.pinned_at,
                    archivedAt: row.archived_at,
                    createdAt: row.created_at,
                    updatedAt: row.updated_at,
                    deletedAt: row.deleted_at,
                  },
                  "projects",
                );
              }
              if (codec) {
                const payload = parse(String(row.payload_json));
                if (payload === undefined) {
                  counts.rejected++;
                  counts.unexpected++;
                  bump(counts.failures, `${record} / invalid-json`);
                  continue;
                }
                inspect(counts, codec, payload, record);
                if (object(payload))
                  for (const marker of markers)
                    if (
                      payload[marker] !== null &&
                      payload[marker] !== undefined &&
                      payload[marker] !== false
                    )
                      bump(
                        census,
                        `${table} / ${marker}`,
                        Array.isArray(payload[marker]) ? payload[marker].length : 1,
                      );
              }
              for (const [key, jsonCodec] of Object.entries(columnCodecs)) {
                const [owner, column] = key.split(".");
                if (
                  owner === table &&
                  table !== "projection_projects" &&
                  row[column!] !== null &&
                  row[column!] !== undefined
                ) {
                  const payload = parse(String(row[column!]));
                  if (payload === undefined) {
                    counts.rejected++;
                    counts.unexpected++;
                    bump(counts.failures, `${column} / invalid-json`);
                  } else inspect(counts, jsonCodec, payload, key, column!);
                }
              }
              if (counts.rejected > rejectedBefore) counts.rejected = rejectedBefore + 1;
            }
            if (rows.length < 128) break;
            cursor = pk.map(
              (key) =>
                rows.at(-1)![withoutRowid ? key : "__cursor"] as
                  | string
                  | number
                  | bigint
                  | Uint8Array
                  | null,
            );
          }
        }
        if (
          table.startsWith("styal_legacy_v1_") ||
          [
            "projection_threads",
            "orchestration_v2_legacy_imports",
            "orchestration_v2_projection_provider_session_bindings",
            "scheduled_task_webhook_pending",
            "scheduled_task_webhook_relay_deliveries",
            "auth_sessions",
            "auth_pairing_links",
            "peer_environment_links",
            "provider_session_runtime",
            "scheduled_task_webhook_deliveries",
            "webhook_relay_pending",
          ].includes(table)
        )
          census[`${table} / rows`] = counts.rows;
        unexpected += counts.unexpected;
        timing[table] = performance.now() - at;
        progress(
          `${table}: ${counts.rows} rows; ${counts.rejected} rejected; ${Math.round(timing[table])} ms`,
        );
      }
      timing.readers = performance.now() - scanStarted;
      const gatesAt = performance.now();
      const prefix = "orchestration_v2_projection_";
      const checks = {
        "nonpositive-event-sequence":
          "SELECT count(*) n FROM orchestration_events WHERE sequence<=0",
        "projection-version-not-2": `SELECT count(*) n FROM ${prefix}metadata WHERE projection_name='thread-projections' AND schema_version!=2`,
        "projection-cursor-missing": `SELECT count(*)=0 n FROM ${prefix}metadata WHERE projection_name='thread-projections'`,
        "unprojected-event-tail": `SELECT count(*) n FROM orchestration_events WHERE sequence>(SELECT max(last_sequence) FROM ${prefix}metadata WHERE projection_name='thread-projections')`,
        "invalid-metadata-cursor": `SELECT count(*) n FROM ${prefix}metadata WHERE last_sequence<0 OR last_sequence>9007199254740991 OR last_sequence>max((SELECT coalesce(max(sequence),0) FROM orchestration_events),(SELECT coalesce(max(seq),0) FROM sqlite_sequence WHERE name='orchestration_events'))`,
        "pruning-beyond-projection": `SELECT count(*) n FROM ${prefix}metadata WHERE projection_name IN ('event-log-pruned-through','event-log-prune-mark') AND last_sequence>(SELECT max(last_sequence) FROM ${prefix}metadata WHERE projection_name='thread-projections')`,
        "unknown-event-application-version":
          "SELECT count(*) n FROM orchestration_events WHERE application_event_version NOT IN (1,2)",
        "unknown-event-aggregate-kind":
          "SELECT count(*) n FROM orchestration_events WHERE aggregate_kind NOT IN ('thread','project')",
        "event-streams-without-v2-snapshot": `SELECT count(DISTINCT stream_id) n FROM orchestration_events e WHERE aggregate_kind='thread' AND application_event_version=2 AND NOT EXISTS(SELECT 1 FROM ${prefix}threads t WHERE t.thread_id=e.stream_id)`,
        "event-streams-without-v1-snapshot": `SELECT count(DISTINCT stream_id) n FROM orchestration_events e WHERE aggregate_kind='thread' AND application_event_version=1 AND NOT EXISTS(SELECT 1 FROM projection_threads t WHERE t.thread_id=e.stream_id)`,
        "fork-cancellation-pairs": `SELECT count(*) n FROM ${prefix}runs r JOIN ${prefix}run_attempts a ON a.run_id=r.run_id WHERE r.status='rolled_back' AND a.status='cancelled'`,
        "runtime-requests-pending": `SELECT count(*) n FROM ${prefix}runtime_requests WHERE status='pending'`,
        "runtime-requests-historical": `SELECT count(*) n FROM ${prefix}runtime_requests WHERE status!='pending'`,
        "orphan-project-threads": `SELECT count(*) n FROM ${prefix}threads t WHERE NOT EXISTS(SELECT 1 FROM projection_projects p WHERE p.project_id=t.project_id)`,
        "position-extra-rows": `SELECT count(*) n FROM orchestration_v2_turn_item_positions p WHERE NOT EXISTS(SELECT 1 FROM ${prefix}turn_items i WHERE i.thread_id=p.thread_id AND i.turn_item_id=p.turn_item_id)`,
        "position-missing-or-disagreeing-rows": `SELECT count(*) n FROM ${prefix}turn_items i WHERE NOT EXISTS(SELECT 1 FROM orchestration_v2_turn_item_positions p WHERE i.thread_id=p.thread_id AND i.turn_item_id=p.turn_item_id AND i.ordinal=p.ordinal)`,
        "legacy-v1-only": `SELECT count(*) n FROM projection_threads a WHERE NOT EXISTS(SELECT 1 FROM ${prefix}threads b WHERE b.thread_id=a.thread_id)`,
        "unfinished-legacy-imports":
          "SELECT count(*) n FROM orchestration_v2_legacy_imports WHERE transcript_imported_at IS NULL",
      };
      for (const [name, query] of Object.entries(checks))
        globals[name] = Number((yield* sql.unsafe<{ n: number }>(query))[0]!.n);
      const excludedKinds = [
        [
          "legacy-v1-event / unsupported-reader",
          "aggregate_kind='thread' AND application_event_version=1",
        ],
        [
          "unsupported-version-event / unsupported-reader",
          "aggregate_kind='thread' AND application_event_version NOT IN (1,2)",
        ],
        [
          "unrecognised-aggregate-event / unsupported-reader",
          "aggregate_kind NOT IN ('thread','project')",
        ],
        [
          "events / sequence",
          "sequence<=0 AND (aggregate_kind='project' OR (aggregate_kind='thread' AND application_event_version=2))",
        ],
      ] as const;
      const excluded = (yield* sql.unsafe<Record<string, number>>(
        `SELECT ${excludedKinds
          .map(
            ([, predicate], index) =>
              `coalesce(sum(CASE WHEN ${predicate} THEN 1 ELSE 0 END),0) AS ${q("excluded_" + index)}`,
          )
          .join(",")} FROM orchestration_events`,
      ))[0]!;
      for (const [index, [reason]] of excludedKinds.entries()) {
        const count = excluded["excluded_" + index]!;
        if (!tables.orchestration_events!.scanSkipped) tables.orchestration_events!.rows += count;
        tables.orchestration_events!.rejected += count;
        if (count) bump(tables.orchestration_events!.failures, reason, count);
        if (index === 0) unexpected += count;
      }
      for (const key of [
        "nonpositive-event-sequence",
        "projection-version-not-2",
        "projection-cursor-missing",
        "unprojected-event-tail",
        "invalid-metadata-cursor",
        "pruning-beyond-projection",
        "unknown-event-application-version",
        "unknown-event-aggregate-kind",
      ])
        unexpected += globals[key]!;
      timing.gates = performance.now() - gatesAt;
    }
    timing.total = performance.now() - started;
    return {
      verdict: unexpected ? "unexpected" : "ready",
      unexpected,
      ledgers,
      schema: differences,
      globals,
      tables,
      census,
      timing,
    };
  }).pipe(
    Effect.provide(
      Layer.merge(
        NodeSqliteClient.layer({
          filename: NodeURL.pathToFileURL(filename).href + "?mode=ro",
          readonly: true,
          readerWorker: false,
          writerWorker: false,
        }),
        Logger.layer([], { mergeWithExisting: false }),
      ),
    ),
    Effect.scoped,
    Effect.catchIf(isSqlError, () =>
      Effect.fail(
        new PreflightRefusal({
          category: "read-only-source-unavailable-use-snapshot-with-sidecars-or-writable-copy",
        }),
      ),
    ),
  );
  const after = yield* Effect.sync(() => sidecars(filename));
  const mainAfter = yield* Effect.sync(() => mainRevision(filename));
  // data_version advances on stable read-only WAL/SHM views; use file revisions across the open.
  if (
    mainBefore !== mainAfter ||
    ((before.wal.size > 0 || after.wal.size > 0) &&
      (before.wal.size !== after.wal.size || before.wal.revision !== after.wal.revision))
  ) {
    report.globals["source-changed"] = 1;
    report.unexpected++;
    report.verdict = "unexpected";
  }
  const changed = (["wal", "shm"] as const).filter(
    (name) =>
      before[name].exists !== after[name].exists ||
      before[name].size !== after[name].size ||
      before[name].revision !== after[name].revision,
  );
  return {
    ...report,
    sidecars: { before: sidecarFacts(before), after: sidecarFacts(after), changed },
  };
});
