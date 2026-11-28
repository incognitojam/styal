import { columnCodecs, projectionCodecs } from "./codecs.ts";
import source from "./source.json" with { type: "json" };

export const leftInPlace = {
  // Event logs are explicitly excluded. The active log has retention/tombstone writes; the old log has no post-86 writer.
  "orchestration_events.payload_json": "event-log-excluded",
  "orchestration_events.metadata_json": "event-log-excluded",
  "orchestration_v2_events.payload_json": "retired-event-log-untouched",
  // Old receipts were copied before the pin; only orchestration_command_receipts has a restart writer.
  "orchestration_v2_command_receipts.error": "retired-table-untouched",
  // The only restart write to this legacy table changes title, not these columns; no row deletion.
  "projection_threads.title_state_json": "legacy-column-untouched",
  "projection_threads.token_usage_json": "legacy-column-untouched",
  // No restart writer, later migration, maintenance list or planned neutralisation targets these fork tables.
  "styal_projection_legacy_turn_usage.payload_json": "retired-table-untouched",
  "styal_legacy_v1_thread_activities.payload_json": "retired-table-untouched",
  "styal_legacy_v1_turns.checkpoint_files_json": "retired-table-untouched",
  "styal_legacy_v1_rederived_items.previous_fields_json": "retired-table-untouched",
  "styal_legacy_v1_rederived_items.absent_fields_json": "retired-table-untouched",
  "hardware_audit_events.detail_json": "retired-table-untouched",
  "hardware_leases.release_plan_json": "retired-table-untouched",
} as const;

// JSON without a *_json name, plus opaque context/request payloads whose owners can delete them.
const opaqueColumns = [
  "auth_sessions.scopes",
  "auth_pairing_links.scopes",
  "scheduled_task_webhook_deliveries.body",
  "mcp_app_model_context.text",
  "orchestration_command_receipts.error",
  "orchestration_v2_command_receipts.error",
];
const mutableTables = new Set([
  "projection_projects",
  "projection_thread_messages",
  "pull_request_review_guides",
  "auth_sessions",
  "auth_pairing_links",
  "peer_environment_links",
  "scheduled_tasks",
  "scheduled_task_webhook_pending",
  "scheduled_task_webhook_deliveries",
  "provider_session_runtime",
]);
export const archiveInventory = source.definitions
  .filter((table) => table.type === "table")
  .flatMap((table) =>
    table.columns.flatMap((column) => {
      const key = `${table.name}.${column.name}`;
      if (
        (!column.name.endsWith("_json") && !opaqueColumns.includes(key)) ||
        Object.hasOwn(leftInPlace, key)
      )
        return [];
      const record = table.name.replace("orchestration_v2_projection_", "");
      const codec =
        column.name === "payload_json" && table.name.startsWith("orchestration_v2_projection_")
          ? projectionCodecs[record as keyof typeof projectionCodecs]
          : columnCodecs[key as keyof typeof columnCodecs];
      return [
        {
          table: table.name,
          column: column.name,
          record: column.name === "payload_json" ? record : key,
          codec,
          preserve:
            mutableTables.has(table.name) || table.name.startsWith("orchestration_v2_projection_"),
        },
      ];
    }),
  );
