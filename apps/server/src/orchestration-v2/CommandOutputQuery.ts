import {
  OrchestrationGetCommandOutputInput,
  type OrchestrationGetCommandOutputResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type PersistenceDecodeError,
  type PersistenceSqlError,
} from "../persistence/Errors.ts";

const MAX_OUTPUT_LENGTH = 256 * 1024;
const TRUNCATION_MARKER = "\n… output truncated …\n";
const CommandActivityRow = Schema.Struct({
  kind: Schema.String,
  payload: Schema.fromJsonString(Schema.Unknown),
});
type CommandActivityRow = typeof CommandActivityRow.Type;

const emptyResult = (
  status: OrchestrationGetCommandOutputResult["status"],
  exitCode: number | null = null,
): OrchestrationGetCommandOutputResult => ({
  status,
  output: null,
  stdout: null,
  stderr: null,
  exitCode,
});

export class CommandOutputQuery extends Context.Reference<{
  readonly getCommandOutput: (
    input: OrchestrationGetCommandOutputInput,
  ) => Effect.Effect<
    OrchestrationGetCommandOutputResult,
    PersistenceSqlError | PersistenceDecodeError
  >;
}>("t3/orchestration/CommandOutputQuery", {
  defaultValue: () => ({
    getCommandOutput: () => Effect.succeed(emptyResult("unavailable")),
  }),
}) {}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function readToolResultText(value: unknown): string | null {
  const direct = readText(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    const parts = value.flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (!Predicate.isObject(entry)) return [];
      return [readText(entry.text), readText(entry.content)].filter(
        (part): part is string => part !== null,
      );
    });
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (!Predicate.isObject(value)) return null;
  return readToolResultText(value.content) ?? readText(value.text) ?? readText(value.output);
}

function truncateMiddle(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const retainedLength = limit - TRUNCATION_MARKER.length;
  const headLength = Math.ceil(retainedLength / 2);
  return `${value.slice(0, headLength)}${TRUNCATION_MARKER}${value.slice(
    -(retainedLength - headLength),
  )}`;
}

function parseLegacyOutput(detail: unknown) {
  const value = readText(detail);
  const match = value?.match(/(?:\r?\n)?<exited with exit code\s+(-?\d+)\s*>\s*$/iu);
  if (!value || !match) return { output: null, exitCode: null };
  const exitCode = Number(match[1]);
  return {
    output: readText(value.slice(0, match.index)),
    exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
  };
}

export function normalizeCommandOutput(
  row: CommandActivityRow | null,
  limit = MAX_OUTPUT_LENGTH,
): OrchestrationGetCommandOutputResult {
  if (row === null || !Predicate.isObject(row.payload)) return emptyResult("unavailable");
  const payload = row.payload;
  if (row.kind === "command_execution") {
    // Imported history may still carry its original V1 payloads until the startup pass in
    // legacy/slimImportedHistory.ts folds their output into the canonical item.
    const retained = Array.isArray(payload.legacyActivities)
      ? payload.legacyActivities.toReversed().flatMap((activity) => {
          if (!Predicate.isObject(activity) || typeof activity.kind !== "string") return [];
          if (!Predicate.isObject(activity.payload)) return [];
          return [
            normalizeCommandOutput({ kind: activity.kind, payload: activity.payload }, limit),
          ];
        })
      : [];
    const fallback =
      retained.find(
        (result) => result.output !== null || result.stdout !== null || result.stderr !== null,
      ) ?? retained.find((result) => result.status === "available");
    const exitCode =
      readInteger(payload.exitCode) ??
      retained.find((result) => result.exitCode !== null)?.exitCode ??
      null;
    const output = readText(payload.output);
    if (output !== null) {
      return {
        status: "available",
        output: truncateMiddle(output, limit),
        stdout: null,
        stderr: null,
        exitCode,
      };
    }
    if (fallback) return { ...fallback, exitCode };
    return emptyResult(
      payload.status === "pending" || payload.status === "running" ? "unavailable" : "available",
      exitCode,
    );
  }
  if (payload.itemType !== "command_execution" && payload.itemType !== "commandExecution") {
    return emptyResult("unavailable");
  }

  const data = Predicate.isObject(payload.data) ? payload.data : {};
  const item = Predicate.isObject(data.item) ? data.item : {};
  const rawOutput = Predicate.isObject(data.rawOutput) ? data.rawOutput : {};
  const state = Predicate.isObject(data.state) ? data.state : {};
  const stateMetadata = Predicate.isObject(state.metadata) ? state.metadata : {};
  const legacy = parseLegacyOutput(payload.detail);
  const exitCode =
    readInteger(item.exitCode) ??
    readInteger(rawOutput.exitCode) ??
    readInteger(state.exitCode) ??
    readInteger(stateMetadata.exitCode) ??
    legacy.exitCode;
  const stdout = readText(rawOutput.stdout);
  const stderr = readText(rawOutput.stderr);
  if (stdout !== null || stderr !== null) {
    const streamLimit = Math.floor(limit / 2);
    return {
      status: "available",
      output: null,
      stdout: stdout === null ? null : truncateMiddle(stdout, streamLimit),
      stderr: stderr === null ? null : truncateMiddle(stderr, streamLimit),
      exitCode,
    };
  }

  const output =
    readText(item.aggregatedOutput) ??
    readText(state.output) ??
    readText(state.error) ??
    readToolResultText(data.result) ??
    readText(rawOutput.content) ??
    legacy.output;
  if (output !== null) {
    return {
      status: "available",
      output: truncateMiddle(output, limit),
      stdout: null,
      stderr: null,
      exitCode,
    };
  }

  const lifecycleStatus =
    readText(payload.status) ?? readText(item.status) ?? readText(state.status);
  return emptyResult(
    row.kind === "tool.completed" || lifecycleStatus === "completed" || lifecycleStatus === "failed"
      ? "available"
      : "unavailable",
    exitCode,
  );
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const getCommandActivityRow = SqlSchema.findOneOption({
    Request: OrchestrationGetCommandOutputInput,
    Result: CommandActivityRow,
    execute: ({ threadId, activityId }) =>
      sql`
        SELECT type AS kind, payload_json AS "payload"
        FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND type = 'command_execution'
          AND (
            turn_item_id = ${activityId}
            OR EXISTS (
              SELECT 1 FROM json_each(payload_json, '$.legacyActivities') AS activity
              WHERE json_extract(activity.value, '$.id') = ${activityId}
            )
          )
        ORDER BY (turn_item_id = ${activityId}) DESC
        LIMIT 1
      `,
  });

  const getCommandOutput: (typeof CommandOutputQuery.Service)["getCommandOutput"] = Effect.fn(
    "CommandOutputQuery.getCommandOutput",
  )(function* (input) {
    const row = yield* getCommandActivityRow(input).pipe(
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? toPersistenceDecodeError("CommandOutputQuery.getCommandOutput:decodeRow")(cause)
          : toPersistenceSqlError("CommandOutputQuery.getCommandOutput:query")(cause),
      ),
    );
    return normalizeCommandOutput(Option.getOrNull(row));
  });

  return { getCommandOutput };
});

export const layer = Layer.effect(CommandOutputQuery, make);

/**
 * The complete output and exit code a converted V1 command recorded, read from its canonical
 * fields or, failing those, from the V1 payloads it was converted from. Imports and
 * legacy/slimImportedHistory.ts fold this into the item so the V1 payloads need not be kept.
 */
export function recordedCommandOutput(payload: Record<string, unknown>): {
  readonly output: string | null;
  readonly exitCode: number | null;
} {
  const result = normalizeCommandOutput(
    { kind: "command_execution", payload },
    Number.POSITIVE_INFINITY,
  );
  const streams = [result.stdout, result.stderr].filter((part) => part !== null);
  return {
    output: result.output ?? (streams.length === 0 ? null : streams.join("\n")),
    exitCode: result.exitCode,
  };
}
