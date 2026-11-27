// @effect-diagnostics nodeBuiltinImport:off - Offline SQLite tooling needs synchronous Node file and descriptor operations.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as Contracts from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { InventoryRefusal } from "./errors.ts";
import { isLivePath } from "./safety.ts";
import { inspectTarget } from "./target.ts";
import { columnCodecs, projectionCodecs, schemaKeys } from "./codecs.ts";
import source from "./source.json" with { type: "json" };
import { compareSchema, isSqliteStatistics } from "./schema.ts";

const digest = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
function fileDigest(filename: string) {
  const descriptor = NodeFS.openSync(
    filename,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const hash = NodeCrypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let length: number;
    while ((length = NodeFS.readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, length));
    return hash.digest("hex");
  } finally {
    NodeFS.closeSync(descriptor);
  }
}
const fingerprint = (value: unknown) => digest(JSON.stringify(value));
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

function refuse(category: string): never {
  throw new InventoryRefusal({ category });
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keys = new Set(source.keys);
const targetCodecs: Schema.Constraint[] = [
  ...Object.values(projectionCodecs),
  ...Object.values(columnCodecs),
  Contracts.ServerSettings,
  Contracts.OrchestrationV2DomainEventJson,
  Contracts.ApplicationProjectEvent,
];
for (const codec of targetCodecs) schemaKeys(codec.ast, keys);
const safeKey = (key: string) => (keys.has(key) ? key : "unrecognised-field");
const MetadataRecord = Schema.Struct({
  last_sequence: Contracts.NonNegativeInt,
  updated_at: Contracts.IsoDateTime,
});
const EventHeader = Contracts.OrchestrationV2StoredEvent.mapFields(
  ({ event: _event, ...fields }) => fields,
);
const decodeEventHeader = Schema.decodeUnknownSync(EventHeader);
const settingsFields = Contracts.ServerSettings.fields as Readonly<
  Record<string, Schema.ConstraintCodec<unknown, unknown>>
>;
const sourceDefinitions = new Map(source.definitions.map((entry) => [entry.name, entry]));
const safeTable = (table: string, target: Set<string>) =>
  sourceDefinitions.has(table) ||
  target.has(table) ||
  isSqliteStatistics({ type: "table", name: table })
    ? table
    : "unrecognised-table";

function checkOffline(filename: string) {
  for (const suffix of ["-wal", "-journal"]) {
    if (NodeFS.existsSync(filename + suffix) && NodeFS.statSync(filename + suffix).size > 0) {
      refuse(suffix === "-wal" ? "checkpointed-offline-copy-required" : "hot-journal-refused");
    }
  }
}

export function sourcePath(input: string) {
  const path = NodePath.resolve(input);
  if (isLivePath(path)) refuse("live-source-refused");
  const resolved = NodeFS.realpathSync(path);
  if (isLivePath(resolved)) refuse("live-source-refused");
  const stat = NodeFS.statSync(resolved);
  if (!stat.isFile() || stat.nlink !== 1) refuse("regular-unlinked-file-required");
  checkOffline(path);
  checkOffline(resolved);
  return resolved;
}

function definitions(rows: ReadonlyArray<Record<string, unknown>>) {
  return rows.map((row) => ({
    type: ["table", "index", "trigger", "view"].includes(String(row.type))
      ? String(row.type)
      : "unrecognised-definition",
    name: String(row.name),
    table: String(row.tbl_name),
    hash: fingerprint(row.sql),
  }));
}
function columns(db: NodeSqlite.DatabaseSync, table: string) {
  return db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all();
}
function ledger(db: NodeSqlite.DatabaseSync, table: string) {
  return db.prepare(`SELECT migration_id, name FROM ${quote(table)} ORDER BY migration_id`).all();
}

interface Outcomes {
  rows: number;
  clean: number;
  storageRestored: number;
  drops: number;
  fails: Record<string, number>;
  fields: Record<string, number>;
  changed: number;
  normalisedFields: Record<string, number>;
}
const outcomes = (): Outcomes => ({
  rows: 0,
  storageRestored: 0,
  clean: 0,
  drops: 0,
  fails: {},
  fields: {},
  changed: 0,
  normalisedFields: {},
});
function increment(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

// Diff encoded JSON, not decoded DateTime objects. Never retain leaf values or dynamic dictionary keys.
function losses(
  before: unknown,
  after: unknown,
  fields: Set<string>,
  normalised: Set<string>,
  field = "representation",
): boolean {
  if (Array.isArray(before)) {
    if (!Array.isArray(after)) return true;
    return (
      before
        .map((value, index) => losses(value, after[index], fields, normalised, field))
        .some(Boolean) || before.length !== after.length
    );
  }
  if (object(before)) {
    if (!object(after)) return true;
    let changed = false;
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) fields.add(safeKey(key));
      else changed = losses(before[key], after[key], fields, normalised, key) || changed;
    }
    for (const key of Object.keys(after)) {
      if (!Object.hasOwn(before, key)) {
        normalised.add(safeKey(key));
        changed = true;
      }
    }
    return changed;
  }
  if (before !== after) normalised.add(safeKey(field));
  return before !== after;
}

const compiled = new Map<
  Schema.ConstraintCodec<unknown, unknown>,
  { read: (value: unknown) => unknown; write: (value: unknown) => unknown }
>();
function decode(codec: Schema.ConstraintCodec<unknown, unknown>, value: unknown, result: Outcomes) {
  try {
    let parser = compiled.get(codec);
    if (!parser) {
      parser = { read: Schema.decodeUnknownSync(codec), write: Schema.encodeUnknownSync(codec) };
      compiled.set(codec, parser);
    }
    const decoded = parser.read(value);
    const encoded = parser.write(decoded);
    const fields = new Set<string>();
    const normalised = new Set<string>();
    const changed = losses(value, encoded, fields, normalised);
    normalised.forEach((field) => increment(result.normalisedFields, field));
    if (fields.size) {
      result.drops++;
      fields.forEach((field) => increment(result.fields, field));
    } else if (!changed) result.clean++;
    if (changed) result.changed++;
  } catch {
    increment(result.fails, "target-schema-rejected");
  }
}
function parse(value: unknown, result: Outcomes): { value: unknown } | undefined {
  if (typeof value !== "string") {
    increment(result.fails, "invalid-json-storage");
    return;
  }
  try {
    return { value: JSON.parse(value) as unknown };
  } catch {
    increment(result.fails, "invalid-json");
    return;
  }
}

const archiveTables = new Set([
  "styal_legacy_v1_thread_activities",
  "styal_legacy_v1_turns",
  "styal_projection_legacy_turn_usage",
  "hardware_audit_events",
  "hardware_leases",
  "workspace_port_allocations",
  "worktree_stripped",
]);
const neutraliseTables = new Set([
  "auth_sessions",
  "auth_pairing_links",
  "peer_environment_links",
  "orchestration_v2_effect_outbox",
  "orchestration_v2_thread_launch_workflows",
  "scheduled_tasks",
  "scheduled_task_webhook_deliveries",
  "scheduled_task_webhook_pending",
  "scheduled_task_webhook_relay_deliveries",
  "scheduled_task_webhook_replay_keys",
  "provider_session_runtime",
]);

export async function inventory(input: { source: string; settings?: string }) {
  const filename = sourcePath(input.source);
  const before = fileDigest(filename);
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    // immutable=1 forbids sidecar creation even for a WAL-mode main database; nonempty WAL was refused above.
    const url = NodeURL.pathToFileURL(filename);
    url.search = "mode=ro&immutable=1";
    db = new NodeSqlite.DatabaseSync(url.href, { readOnly: true, allowExtension: false });
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    const knownTables = new Set(
      definitions(
        db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
      )
        .filter((entry) => entry.type === "table")
        .map((entry) => entry.name),
    );
    if (!knownTables.has("effect_sql_migrations") || !knownTables.has("yngatech_sql_migrations"))
      refuse("unrecognised-migration-ledger");
    if (
      fingerprint(ledger(db, "effect_sql_migrations")) !== fingerprint(source.ledger) ||
      fingerprint(ledger(db, "yngatech_sql_migrations")) !== fingerprint(source.forkLedger)
    )
      refuse("unrecognised-migration-ledger");
    const target = await Effect.runPromise(inspectTarget().pipe(Effect.scoped));
    const targetDefinitions = definitions(target.definitions);
    const targetNames = new Set(targetDefinitions.map((entry) => entry.name));
    const sourceSchema = definitions(
      db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
    );
    const sourceTables = sourceSchema.filter((entry) => entry.type === "table");
    const targetTables = targetDefinitions.filter((entry) => entry.type === "table");
    const tables: {
      table: string;
      count: number;
      schema: string;
      removed: string[];
      added: string[];
      changed: string[];
      action: string;
    }[] = [];
    const payloads: Record<string, Outcomes> = {};
    let blocking = 0;
    const blockers: Record<string, number> = {};
    const block = (category: string, count = 1) => {
      blocking += count;
      blockers[category] = (blockers[category] ?? 0) + count;
    };
    for (const entry of sourceTables) {
      if (isSqliteStatistics(entry)) {
        tables.push({
          table: entry.name,
          count: Number(db.prepare(`SELECT count(*) AS n FROM ${quote(entry.name)}`).get()!.n),
          schema: "source-only",
          removed: [],
          added: [],
          changed: [],
          action: "carry",
        });
        continue;
      }
      const name = safeTable(entry.name, targetNames);
      const sourceColumns = columns(db, entry.name);
      const match = targetTables.find((candidate) => candidate.name === entry.name);
      const targetColumns = match ? (target.columns[entry.name] ?? []) : [];
      const knownColumns = new Set<string>(
        (sourceDefinitions.get(entry.name)?.columns ?? []).map((column) => column.name),
      );
      targetColumns.forEach((column) => knownColumns.add(String(column.name)));
      const safeColumn = (column: unknown) =>
        typeof column === "string" && knownColumns.has(column) ? column : "unrecognised-column";
      const removed = sourceColumns
        .filter((column) => !targetColumns.some((candidate) => candidate.name === column.name))
        .map((column) => safeColumn(column.name));
      const added = targetColumns
        .filter((column) => !sourceColumns.some((candidate) => candidate.name === column.name))
        .map((column) => safeColumn(column.name));
      const changed = sourceColumns
        .filter((column) =>
          targetColumns.some(
            (candidate) =>
              candidate.name === column.name && fingerprint(candidate) !== fingerprint(column),
          ),
        )
        .map((column) => safeColumn(column.name));
      const count = Number(db.prepare(`SELECT count(*) AS n FROM ${quote(entry.name)}`).get()!.n);
      const schema = !match ? "source-only" : entry.hash === match.hash ? "same" : "changed";
      const derived =
        entry.name.includes("message_search") ||
        entry.name.includes("item_counts") ||
        entry.name.includes("sql_migrations") ||
        entry.name === "sqlite_sequence";
      const action = derived
        ? "regenerate"
        : neutraliseTables.has(entry.name)
          ? "neutralise"
          : archiveTables.has(entry.name) || !match
            ? "archive"
            : schema === "same"
              ? "carry"
              : "transform";
      if (name === "unrecognised-table") block("unrecognised-table", count || 1);
      if (sourceColumns.some((column) => !knownColumns.has(String(column.name))))
        block("unrecognised-column");
      const expected = sourceDefinitions.get(entry.name);
      if (expected && Object.keys(compareSchema([entry], [expected])).length)
        block("source-schema-drift");
      tables.push({ table: name, count, schema, removed, added, changed, action });
      if (expected && "optional" in expected && expected.optional) continue;
      for (const column of sourceColumns.filter((column) =>
        String(column.name).endsWith("_json"),
      )) {
        if (entry.name === "orchestration_events" || entry.name === "orchestration_v2_events")
          continue;
        const kind = `${name}.${safeColumn(column.name)}`;
        const result = outcomes();
        payloads[kind] = result;
        const projectionKind = entry.name.replace("orchestration_v2_projection_", "");
        const codec =
          column.name === "payload_json" && Object.hasOwn(projectionCodecs, projectionKind)
            ? projectionCodecs[projectionKind as keyof typeof projectionCodecs]
            : columnCodecs[kind as keyof typeof columnCodecs];
        for (const row of db
          .prepare(`SELECT ${quote(String(column.name))} AS value FROM ${quote(entry.name)}`)
          .iterate()) {
          if (row.value === null) continue;
          result.rows++;
          const parsed = parse(row.value, result);
          if (!parsed) continue;
          if (codec) decode(codec, parsed.value, result);
          else {
            increment(result.fails, "unclassified-json-contract");
            block("unclassified-json-contract");
          }
        }
      }
    }
    for (const table of tables) {
      const results = Object.entries(payloads)
        .filter(([kind]) => kind.startsWith(table.table + "."))
        .map(([, result]) => result);
      if (
        table.action === "carry" &&
        results.some((result) => result.drops || result.changed || Object.keys(result.fails).length)
      )
        table.action = "transform";
      if (
        [
          "orchestration_events",
          "orchestration_v2_events",
          "orchestration_v2_projection_runtime_requests",
          "orchestration_v2_projection_subagents",
          "orchestration_v2_projection_metadata",
          "orchestration_v2_projection_runs",
          "orchestration_v2_projection_run_attempts",
          "orchestration_v2_projection_provider_sessions",
          "orchestration_v2_projection_provider_threads",
          "orchestration_v2_projection_provider_turns",
        ].includes(table.table)
      )
        table.action = "transform";
    }
    for (const entry of targetTables.filter(
      (entry) => !sourceTables.some((candidate) => candidate.name === entry.name),
    ))
      tables.push({
        table: entry.name,
        count: 0,
        schema: "target-only",
        removed: [],
        added: (target.columns[entry.name] ?? []).map((column) => String(column.name)),
        changed: [],
        action: "regenerate",
      });
    const events: Record<string, Outcomes> = {};
    for (const eventTable of ["orchestration_events", "orchestration_v2_events"]) {
      for (const row of db.prepare(`SELECT * FROM ${eventTable}`).iterate()) {
        const type =
          typeof row.event_type === "string" &&
          (Contracts.isKnownOrchestrationV2EventType(row.event_type) ||
            [
              "legacy-usage.imported",
              "message.mentioned-times-checked",
              "project.created",
              "project.meta-updated",
              "project.deleted",
            ].includes(row.event_type))
            ? row.event_type
            : "unrecognised-event";
        const kind = `${eventTable}.${type}`;
        const result = (events[kind] ??= outcomes());
        result.rows++;
        const payload = parse(row.payload_json, result);
        const metadata =
          row.metadata_json === undefined ? { value: {} } : parse(row.metadata_json, result);
        if (type === "unrecognised-event") {
          increment(result.fails, "unclassified-event");
          block("unclassified-event");
        }
        if (!payload || !metadata || type === "unrecognised-event") continue;
        if (
          eventTable === "orchestration_events" &&
          ![1, 2].includes(Number(row.application_event_version))
        ) {
          increment(result.fails, "unrecognised-application-version");
          block("unrecognised-application-version");
          continue;
        }
        if (
          eventTable === "orchestration_events" &&
          !["thread", "project"].includes(String(row.aggregate_kind))
        ) {
          increment(result.fails, "unrecognised-stream-kind");
          block("unrecognised-stream-kind");
          continue;
        }
        if (
          eventTable === "orchestration_events" &&
          object(payload.value) &&
          Number.isInteger(payload.value.promptSequence) &&
          String(row.event_type).startsWith("subagent.")
        ) {
          const anchor = db
            .prepare("SELECT payload_json FROM orchestration_events WHERE sequence = ?")
            .get(Number(payload.value.promptSequence));
          const restored = anchor ? parse(anchor.payload_json, result) : undefined;
          if (!restored || !object(restored.value) || typeof restored.value.prompt !== "string") {
            increment(result.fails, "missing-compacted-prompt");
            block("missing-compacted-prompt");
            continue;
          }
          const { promptSequence: _sequence, ...rest } = payload.value;
          payload.value = { ...rest, prompt: restored.value.prompt };
          result.storageRestored++;
        }
        if (
          eventTable === "orchestration_events" &&
          row.application_event_version !== 2 &&
          row.aggregate_kind !== "project"
        ) {
          increment(result.fails, "legacy-event-no-target-schema");
          continue;
        }
        if (row.aggregate_kind === "project") {
          decode(
            Contracts.ApplicationProjectEvent,
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
              payload: payload.value,
              metadata: metadata.value,
            },
            result,
          );
        } else {
          if (!object(metadata.value)) {
            increment(result.fails, "metadata-not-object");
            block("metadata-not-object");
            continue;
          }
          const meta = metadata.value;
          if (
            ["id", "threadId", "type", "occurredAt", "payload"].some((key) =>
              Object.hasOwn(meta, key),
            )
          ) {
            increment(result.fails, "metadata-header-collision");
            block("metadata-header-collision");
            continue;
          }
          try {
            decodeEventHeader({ sequence: row.sequence, commandId: row.command_id ?? null });
          } catch {
            increment(result.fails, "event-header-rejected");
            continue;
          }
          decode(
            Contracts.OrchestrationV2DomainEventJson,
            {
              ...meta,
              id: row.event_id,
              threadId: row.stream_id ?? row.thread_id,
              type: row.event_type,
              occurredAt: row.occurred_at,
              payload: payload.value,
              ...(eventTable === "orchestration_v2_events"
                ? Object.fromEntries(
                    [
                      ["runId", row.run_id],
                      ["nodeId", row.node_id],
                      ["driver", row.driver],
                      ["providerInstanceId", row.provider_instance_id],
                      ["rawEventId", row.raw_event_id],
                    ].filter(([, value]) => value != null),
                  )
                : {}),
            },
            result,
          );
        }
      }
    }
    const metadata = db
      .prepare(
        "SELECT projection_name, schema_version, last_sequence, updated_at FROM orchestration_v2_projection_metadata",
      )
      .all();
    const versions = { recognised: 0, unrecognised: 0 };
    for (const row of metadata) {
      if (
        (row.projection_name === "thread-projections" &&
          [1, 2].includes(Number(row.schema_version))) ||
        ([
          "event-log-pruned-through",
          "event-log-prune-mark",
          "legacy-plans-reasoning-imported",
        ].includes(String(row.projection_name)) &&
          row.schema_version === 2) ||
        (row.projection_name === "history-rewrite-fence" && row.schema_version === 1)
      )
        versions.recognised++;
      else {
        versions.unrecognised++;
        block("unrecognised-projection-version");
      }
    }
    const allocation = Number(
      db
        .prepare(
          "SELECT max(value) AS n FROM (SELECT coalesce(max(sequence), 0) AS value FROM orchestration_events UNION ALL SELECT coalesce(max(seq), 0) FROM sqlite_sequence WHERE name = 'orchestration_events')",
        )
        .get()!.n,
    );
    const freshMetadata = target.metadata;
    const cursors = {
      withinAllocation: 0,
      beyondAllocation: 0,
      invalidRows: 0,
      pruningBeyondProjection: 0,
      sameKindAsFreshTarget: 0,
      sourceOnlyKinds: 0,
    };
    const projectionCursor = metadata.find(
      (row) => row.projection_name === "thread-projections",
    )?.last_sequence;
    for (const row of metadata) {
      const result = outcomes();
      decode(
        MetadataRecord,
        { last_sequence: row.last_sequence, updated_at: row.updated_at },
        result,
      );
      if (Object.keys(result.fails).length || !Number.isSafeInteger(row.last_sequence)) {
        cursors.invalidRows++;
        block("invalid-projection-cursor");
      } else if (Number(row.last_sequence) > allocation) {
        cursors.beyondAllocation++;
        block("cursor-beyond-sequence-allocation");
      } else cursors.withinAllocation++;
      if (
        ["event-log-pruned-through", "event-log-prune-mark"].includes(
          String(row.projection_name),
        ) &&
        (typeof projectionCursor !== "number" || Number(row.last_sequence) > projectionCursor)
      ) {
        cursors.pruningBeyondProjection++;
        block("pruning-beyond-projection");
      }
      if (freshMetadata.some((fresh) => fresh.projection_name === row.projection_name))
        cursors.sameKindAsFreshTarget++;
      else cursors.sourceOnlyKinds++;
    }
    const pruning = {
      legacyThreads: Number(db.prepare("SELECT count(*) AS n FROM projection_threads").get()!.n),
      legacyOnly: Number(
        db
          .prepare(
            "SELECT count(*) AS n FROM projection_threads v1 LEFT JOIN orchestration_v2_projection_threads v2 ON v2.thread_id = v1.thread_id WHERE v2.thread_id IS NULL",
          )
          .get()!.n,
      ),
      importMarkers: Number(
        db.prepare("SELECT count(*) AS n FROM orchestration_v2_legacy_imports").get()!.n,
      ),
      unfinishedImports: Number(
        db
          .prepare(
            "SELECT count(*) AS n FROM orchestration_v2_legacy_imports WHERE transcript_imported_at IS NULL",
          )
          .get()!.n,
      ),
      streams: [] as {
        kind: string;
        total: number;
        snapshotsOnly: number;
        incomplete: number;
        candidateComplete: number;
        eventsWithoutSnapshot: number;
      }[],
    };
    for (const [kind, table, id, aggregate, version] of [
      ["thread-v2", "orchestration_v2_projection_threads", "thread_id", "thread", 2],
      ["thread-v1", "projection_threads", "thread_id", "thread", 1],
      ["project", "projection_projects", "project_id", "project", 1],
    ] as const) {
      const result = {
        kind,
        total: 0,
        snapshotsOnly: 0,
        incomplete: 0,
        candidateComplete: 0,
        eventsWithoutSnapshot: 0,
      };
      for (const snapshot of db.prepare(`SELECT ${id} AS id FROM ${table}`).iterate()) {
        result.total++;
        const stream = db
          .prepare(
            "SELECT count(DISTINCT stream_version) AS n, min(stream_version) AS first, max(stream_version) AS last FROM orchestration_events WHERE stream_id = ? AND aggregate_kind = ? AND application_event_version = ?",
          )
          .get(snapshot.id!, aggregate, version);
        if (!stream?.n) result.snapshotsOnly++;
        else if (stream.first === 1 && stream.n === stream.last) result.candidateComplete++;
        else result.incomplete++;
      }
      result.eventsWithoutSnapshot = Number(
        db
          .prepare(
            `SELECT count(DISTINCT e.stream_id) AS n FROM orchestration_events e LEFT JOIN ${table} p ON p.${id} = e.stream_id WHERE e.aggregate_kind = ? AND e.application_event_version = ? AND p.${id} IS NULL`,
          )
          .get(aggregate, version)!.n,
      );
      pruning.streams.push(result);
    }
    const legacyEventCopies = db
      .prepare(
        "SELECT count(*) AS total, sum(EXISTS(SELECT 1 FROM orchestration_events a WHERE a.event_id = old.event_id)) AS duplicated FROM orchestration_v2_events old",
      )
      .get()!;
    const settings = {
      accepted: [] as string[],
      unknown: [] as string[],
      unrecognised: 0,
      compatibility: {} as Record<string, Outcomes>,
    };
    if (input.settings) {
      const parsed: unknown = JSON.parse(NodeFS.readFileSync(sourcePath(input.settings), "utf8"));
      if (!object(parsed)) refuse("invalid-settings-object");
      for (const key of Object.keys(parsed)) {
        if (Object.hasOwn(Contracts.ServerSettings.fields, key)) {
          settings.accepted.push(key);
          const result = outcomes();
          result.rows++;
          settings.compatibility[key] = result;
          decode(settingsFields[key]!, parsed[key], result);
          if (Object.keys(result.fails).length) block("incompatible-settings-value");
        } else if (source.settings.includes(key)) settings.unknown.push(key);
        else settings.unrecognised++;
      }
      settings.accepted.sort();
      settings.unknown.sort();
      if (settings.unrecognised) block("unrecognised-settings-key", settings.unrecognised);
    }
    for (const result of [
      ...Object.values(events),
      ...Object.values(payloads),
      ...Object.values(settings.compatibility),
    ]) {
      const unknown =
        (result.fields["unrecognised-field"] ?? 0) +
        (result.normalisedFields["unrecognised-field"] ?? 0);
      if (unknown) block("unrecognised-json-field", unknown);
    }
    const settingsWork = Object.entries(settings.compatibility).map(([key, result]) => ({
      kind: `settings.${key}`,
      action:
        result.drops || result.changed || Object.keys(result.fails).length ? "transform" : "carry",
      blocking: Object.keys(result.fails).length > 0,
      categories: Object.keys(result.fails),
    }));
    for (const key of settings.unknown)
      settingsWork.push({
        kind: `settings.${key}`,
        action: "archive",
        blocking: false,
        categories: ["source-only-setting"],
      });
    if (settings.unrecognised)
      settingsWork.push({
        kind: "settings.unrecognised",
        action: "archive",
        blocking: true,
        categories: ["unrecognised-settings-key"],
      });
    return {
      version: 1,
      verdict: blocking ? "blocked-unclassified" : "requires-data-move",
      blocking,
      blockers,
      source: {
        schema: fingerprint(sourceSchema),
        projectionVersions: fingerprint(
          metadata.map((row) => [row.projection_name, row.schema_version]),
        ),
        ledger: fingerprint(source.ledger),
        forkLedger: fingerprint(source.forkLedger),
        definitions: sourceSchema.map((entry) => ({
          type: entry.type,
          kind: safeTable(entry.name, targetNames),
          hash: entry.hash,
        })),
      },
      target: {
        schema: fingerprint(targetDefinitions),
        projectionVersions: fingerprint(freshMetadata),
        ledger: fingerprint(target.ledger),
      },
      versions,
      cursors,
      tables,
      events,
      payloads,
      pruning,
      settings,
      legacyEventCopies: {
        total: Number(legacyEventCopies.total),
        duplicated: Number(legacyEventCopies.duplicated ?? 0),
      },
      work: Object.entries({ ...events, ...payloads })
        .map(([kind, result]) => {
          const table = kind.split(".")[0]!;
          const action = tables.find((entry) => entry.table === table)?.action;
          const unclassified =
            Object.hasOwn(result.fails, "unclassified-json-contract") ||
            Object.hasOwn(result.fails, "unclassified-event");
          return {
            kind,
            action: unclassified
              ? "archive"
              : ["archive", "neutralise", "regenerate"].includes(action ?? "")
                ? action
                : Object.keys(result.fails).length && kind.startsWith("orchestration_events.")
                  ? "archive"
                  : result.drops || result.changed || Object.keys(result.fails).length
                    ? "transform"
                    : "carry",
            blocking: unclassified,
            categories: Object.keys(result.fails),
          };
        })
        .concat(settingsWork),
    };
  } finally {
    try {
      db?.close();
    } finally {
      try {
        checkOffline(filename);
      } finally {
        if (fileDigest(filename) !== before) refuse("source-changed");
      }
    }
  }
}
