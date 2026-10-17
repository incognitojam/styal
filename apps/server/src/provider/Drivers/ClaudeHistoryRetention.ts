import type { ServerProviderHistoryRetention } from "@t3tools/contracts";
import { PositiveInt } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";

const decodeSettings = Schema.decodeUnknownEffect(
  fromLenientJson(Schema.Struct({ cleanupPeriodDays: Schema.optional(Schema.Unknown) })),
);
const decodeDays = Schema.decodeUnknownOption(PositiveInt);

// Whole string literals (with a following colon when they are keys), comments, and braces.
const JSONC_TOKEN_PATTERN = /("(?:[^"\\]|\\.)*")(\s*:)?|\/\/[^\n]*|\/\*[\s\S]*?\*\/|([{}])/g;

/** 1-based line of the last top-level `cleanupPeriodDays` key, matching JSON's last-key-wins rule. */
const findCleanupPeriodDaysLine = (contents: string): number | undefined => {
  let depth = 0;
  let offset: number | undefined;
  for (const match of contents.matchAll(JSONC_TOKEN_PATTERN)) {
    if (match[3] !== undefined) depth += match[3] === "{" ? 1 : -1;
    else if (depth === 1 && match[1] === '"cleanupPeriodDays"' && match[2] !== undefined) {
      offset = match.index;
    }
  }
  return offset === undefined ? undefined : contents.slice(0, offset).split("\n").length;
};

/** Read only the user rule; project, managed, and session overrides are not resolved here. */
export const readClaudeHistoryRetention = Effect.fn("readClaudeHistoryRetention")(function* (
  configDir: string,
): Effect.fn.Return<ServerProviderHistoryRetention, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsPath = path.join(configDir, "settings.json");
  const defaultRetention = { status: "default", days: 30, settingsPath } as const;
  // Claude Code falls back to its default when the file or value is missing or unusable.
  const contents = yield* fs.readFileString(settingsPath).pipe(Effect.option);
  if (Option.isNone(contents)) return defaultRetention;
  const settings = yield* decodeSettings(contents.value).pipe(Effect.option);
  if (Option.isNone(settings)) return defaultRetention;
  const days = decodeDays(settings.value.cleanupPeriodDays);
  return Option.isSome(days)
    ? {
        status: "configured",
        days: days.value,
        settingsPath,
        line: findCleanupPeriodDaysLine(contents.value),
      }
    : defaultRetention;
});
