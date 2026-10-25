import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * Native installs ignore `autoUpdates: false`; only `DISABLE_AUTOUPDATER` stops self-updates.
 * styal writes it to the settings `env` block with `STYAL_MANAGED_UPDATES` as an ownership
 * record, and removes both only when that record is present, so a user's own value is never
 * touched. Both land in one atomic rename that every styal server on the machine sees.
 */
const CLAUDE_UPDATER_ENV = "DISABLE_AUTOUPDATER";
const CLAUDE_UPDATER_OWNER_ENV = "STYAL_MANAGED_UPDATES";
const OWNED_VALUE = "1";

type JsonObject = { [key: string]: unknown };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Claude's own reading: DISABLE_AUTOUPDATER is on for 1/true/yes/on, the
// others for any non-empty value.
const isTruthyFlag = (value: unknown) =>
  typeof value === "string" && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
const isSet = (value: unknown) => typeof value === "string" && value.length > 0;

function disablesUpdater(env: Readonly<Record<string, unknown>>): boolean {
  return (
    isSet(env.DISABLE_UPDATES) ||
    isTruthyFlag(env[CLAUDE_UPDATER_ENV]) ||
    isSet(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)
  );
}

/**
 * Whether Claude's own updater would run with this environment, user
 * settings and global config, mirroring Claude's check. Null when the
 * settings cannot be understood.
 */
export function claudeUpdaterActive(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly settings: unknown;
  readonly config: unknown;
}): boolean | null {
  if (disablesUpdater(input.env)) return false;
  if (!isObject(input.settings)) return null;
  const settingsEnv = input.settings.env ?? {};
  if (!isObject(settingsEnv)) return null;
  if (disablesUpdater(settingsEnv)) return false;
  // A value styal did not set, even one that leaves the updater on, is the
  // user's decision: not styal's to take over.
  if (CLAUDE_UPDATER_ENV in settingsEnv && !(CLAUDE_UPDATER_OWNER_ENV in settingsEnv)) return null;
  const config = isObject(input.config) ? input.config : {};
  if (
    config.autoUpdates === false &&
    (config.installMethod !== "native" || config.autoUpdatesProtectedForNative !== true)
  )
    return false;
  return true;
}

/** Settings with the updater turned off by styal, or null to leave them as they are. */
function withClaudeUpdaterOff(settings: JsonObject): JsonObject | null {
  const env = settings.env ?? {};
  if (!isObject(env) || CLAUDE_UPDATER_ENV in env) return null;
  return {
    ...settings,
    env: { ...env, [CLAUDE_UPDATER_ENV]: OWNED_VALUE, [CLAUDE_UPDATER_OWNER_ENV]: OWNED_VALUE },
  };
}

/**
 * Settings without what `withClaudeUpdaterOff` added, or null when styal did
 * not set it. A value the user changed since is left in place.
 */
function withClaudeUpdaterHandedBack(settings: JsonObject): JsonObject | null {
  const env = settings.env;
  if (!isObject(env) || !(CLAUDE_UPDATER_OWNER_ENV in env)) return null;
  const { [CLAUDE_UPDATER_OWNER_ENV]: _owner, [CLAUDE_UPDATER_ENV]: updater, ...rest } = env;
  return {
    ...settings,
    env:
      updater === OWNED_VALUE || updater === undefined
        ? rest
        : { ...rest, [CLAUDE_UPDATER_ENV]: updater },
  };
}

export interface ClaudeUpdaterPaths {
  /** The instance's Claude config directory, holding `settings.json`. */
  readonly configDir: string;
  /** Claude's global config, `.claude.json`. */
  readonly accountConfigPath: string;
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

// These helpers run inside the self-updater operations below, which own the spans.
// A missing file reads as empty; one that is not JSON reads as `undefined`.
const readJson = Effect.fnUntraced(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  if (!(yield* fileSystem.exists(filePath))) return { text: null, value: {} as unknown };
  const text = yield* fileSystem.readFileString(filePath);
  return { text, value: Option.getOrUndefined(decodeJson(text)) };
});

const settingsPath = Effect.fnUntraced(function* (paths: ClaudeUpdaterPaths) {
  const path = yield* Path.Path;
  return path.join(paths.configDir, "settings.json");
});

/** Whether native Claude Code's own updater is on for this instance; null when it cannot be read. */
export const claudeSelfUpdaterActive = Effect.fn("claudeSelfUpdaterActive")(
  function* (paths: ClaudeUpdaterPaths, env: NodeJS.ProcessEnv) {
    if (disablesUpdater(env)) return false;
    const settings = yield* readJson(yield* settingsPath(paths));
    const config = yield* readJson(paths.accountConfigPath);
    return claudeUpdaterActive({ env, settings: settings.value, config: config.value });
  },
  Effect.orElseSucceed(() => null),
);

// Claude Code writes its settings with 2-space indentation too.
const encodeSettings = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

// Rewrites settings.json with `edit`, keeping key order and permissions. An
// unparsable file is never replaced.
const editSettings = Effect.fn("editClaudeSettings")(function* (
  paths: ClaudeUpdaterPaths,
  edit: (settings: JsonObject) => JsonObject | null,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const filePath = yield* settingsPath(paths);
  const current = yield* readJson(filePath);
  if (!isObject(current.value)) {
    return yield* Effect.logWarning("Claude settings are not a JSON object; left unchanged", {
      filePath,
    });
  }
  const next = edit(current.value);
  if (next === null) return;
  const mode = current.text === null ? undefined : (yield* fileSystem.stat(filePath)).mode & 0o777;
  const encoded = yield* encodeSettings(next);
  yield* writeFileStringAtomically({
    filePath,
    contents: `${encoded}\n`,
    ...(mode === undefined ? {} : { mode }),
  });
});

/**
 * Turns native Claude Code's own updater off for this instance after styal
 * installed a version, unless it is already off or settings cannot be read.
 */
export const turnOffClaudeSelfUpdater = Effect.fn("turnOffClaudeSelfUpdater")(
  function* (paths: ClaudeUpdaterPaths, env: NodeJS.ProcessEnv) {
    if ((yield* claudeSelfUpdaterActive(paths, env)) !== true) return;
    yield* editSettings(paths, withClaudeUpdaterOff);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Could not turn off Claude Code's own updater", { cause }),
  ),
);

/** Hands updates back to native Claude Code by undoing `turnOffClaudeSelfUpdater`. */
export const handBackClaudeSelfUpdater = Effect.fn("handBackClaudeSelfUpdater")(
  function* (paths: ClaudeUpdaterPaths) {
    yield* editSettings(paths, withClaudeUpdaterHandedBack);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Could not hand updates back to Claude Code's own updater", { cause }),
  ),
);
