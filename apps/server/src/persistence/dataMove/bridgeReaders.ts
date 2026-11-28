import * as Contracts from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { AuthSessionDbRow } from "../AuthSessions.ts";
import { AuthPairingLinkRecord } from "../AuthPairingLinks.ts";
import { AuthConnectDeviceRecord } from "../AuthConnectDevices.ts";
import { ProviderSessionRuntimeDbRowSchema } from "../ProviderSessionRuntime.ts";
import { TaskFolderRow } from "../../workspace/TaskFolderStore.ts";
import { decodeStoredLink } from "../../peer/PeerLinks.ts";
import { decodeStoredTask } from "../../scheduledTasks/ScheduledTaskService.ts";
import { PreflightRefusal } from "./preflight.ts";

const rows = {
  auth_sessions: [AuthSessionDbRow, {}],
  auth_pairing_links: [AuthPairingLinkRecord, { requestedClient: "requested_client_json" }],
  auth_connect_devices: [AuthConnectDeviceRecord, { client: "client_json" }],
  provider_session_runtime: [
    ProviderSessionRuntimeDbRowSchema,
    { resumeCursor: "resume_cursor_json", runtimePayload: "runtime_payload_json" },
  ],
  task_folders: [TaskFolderRow, { repositories: "repositories_json" }],
} as const;
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;

export const verifyBridgeReaders = Effect.fn("DataMove.verifyBridgeReaders")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decoded: Record<string, number> = {};
  for (const [table, [codec, aliases]] of Object.entries(rows)) {
    const fields = Object.keys(codec.fields);
    const rename: Record<string, string> = aliases;
    const select = fields
      .map(
        (field) =>
          `${field === "connectApproved" ? "EXISTS(SELECT 1 FROM auth_connect_devices WHERE auth_connect_devices.proof_key_thumbprint=auth_pairing_links.proof_key_thumbprint)" : q(rename[field] ?? field.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()))} AS ${q(field)}`,
      )
      .join(",");
    let cursor = 0;
    let count = 0;
    for (;;) {
      const page = yield* sql.unsafe<Record<string, unknown> & { cursor: number }>(
        `SELECT rowid AS cursor,${select} FROM ${q(table)} WHERE rowid>? ORDER BY rowid LIMIT 128`,
        [cursor],
      );
      for (const row of page)
        yield* Schema.decodeUnknownEffect(codec)(row).pipe(
          Effect.mapError(
            () => new PreflightRefusal({ category: "restart-row-reader-rejected / " + table }),
          ),
        );
      count += page.length;
      if (page.length) cursor = page.at(-1)!.cursor;
      if (page.length < 128) break;
    }
    decoded[table] = count;
  }
  let cursor = 0;
  let count = 0;
  for (;;) {
    const page = yield* sql.unsafe<Parameters<typeof decodeStoredTask>[0] & { cursor: number }>(
      "SELECT rowid AS cursor,* FROM scheduled_tasks WHERE rowid>? ORDER BY rowid LIMIT 128",
      [cursor],
    );
    for (const row of page)
      yield* decodeStoredTask(row).pipe(
        Effect.mapError(
          () => new PreflightRefusal({ category: "restart-schedule-reader-rejected" }),
        ),
      );
    count += page.length;
    if (page.length) cursor = page.at(-1)!.cursor;
    if (page.length < 128) break;
  }
  decoded.scheduled_tasks = count;
  const decodeMembership = Schema.decodeUnknownEffect(
    Schema.NullOr(Schema.fromJsonString(Schema.Array(Contracts.RunId))),
  );
  let membershipCursor = 0;
  for (;;) {
    const page = yield* sql.unsafe<{ cursor: number; fork_run_ids_json: string | null }>(
      "SELECT rowid AS cursor,fork_run_ids_json FROM orchestration_v2_projection_threads WHERE rowid>? ORDER BY rowid LIMIT 128",
      [membershipCursor],
    );
    for (const row of page)
      yield* decodeMembership(row.fork_run_ids_json).pipe(
        Effect.mapError(
          () => new PreflightRefusal({ category: "restart-membership-reader-rejected" }),
        ),
      );
    if (page.length < 128) break;
    membershipCursor = page.at(-1)!.cursor;
  }
  let peerCursor = 0;
  let peerCount = 0;
  for (;;) {
    const page = yield* sql.unsafe<Parameters<typeof decodeStoredLink>[0] & { cursor: number }>(
      "SELECT rowid AS cursor,* FROM peer_environment_links WHERE rowid>? ORDER BY rowid LIMIT 128",
      [peerCursor],
    );
    for (const row of page)
      yield* decodeStoredLink(row).pipe(
        Effect.mapError(() => new PreflightRefusal({ category: "restart-peer-reader-rejected" })),
      );
    peerCount += page.length;
    if (page.length < 128) {
      decoded.peer_environment_links = peerCount;
      break;
    }
    peerCursor = page.at(-1)!.cursor;
  }

  return decoded;
});
