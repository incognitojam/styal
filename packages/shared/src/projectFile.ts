import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  STYAL_PROJECT_FILE_MAX_ACTIONS,
  STYAL_PROJECT_FILE_NAME,
  STYAL_PROJECT_FILE_SCHEMA_URL,
  StyalProjectFile,
  StyalProjectFileAction,
  type ProjectConfig,
  type ProjectConfigAction,
  type T3ProjectFileScript,
} from "@t3tools/contracts";

import { nextProjectScriptId } from "./projectScripts.ts";
import {
  hasUnknownKeys,
  makeFieldValidators,
  pickValidFields,
  type JsonRecord,
} from "./projectFileRecovery.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { parseT3ProjectFileResult } from "./t3ProjectFile.ts";

/**
 * Codec between the raw `styal.json` file contents (lenient JSONC string) and
 * the decoded {@link StyalProjectFile}.
 */
export const StyalProjectFileFromJson = fromLenientJson(StyalProjectFile);

export type StyalProjectFileParseResult =
  | { readonly status: "valid"; readonly file: StyalProjectFile }
  | { readonly status: "partial"; readonly file: StyalProjectFile }
  | { readonly status: "invalid"; readonly file: null };

const decodeStyalProjectFile = Schema.decodeUnknownExit(StyalProjectFile);
const decodeStyalProjectFileAction = Schema.decodeUnknownExit(StyalProjectFileAction);
const decodeJsonObject = Schema.decodeUnknownExit(Schema.Record(Schema.String, Schema.Unknown));
const decodeJsonArray = Schema.decodeUnknownExit(Schema.Array(Schema.Unknown));
const decodeLenientJson = Schema.decodeExit(fromLenientJson(Schema.Unknown));

const FILE_FIELDS = makeFieldValidators(StyalProjectFile.fields);
const ACTION_FIELDS = makeFieldValidators(StyalProjectFileAction.fields);

/** An action without its invalid optional fields, or null when a required field is invalid. */
function recoverAction(input: unknown): JsonRecord | null {
  const decodedRecord = decodeJsonObject(input);
  if (Exit.isFailure(decodedRecord)) {
    return null;
  }
  const candidate = pickValidFields(decodedRecord.value, ACTION_FIELDS);
  return Exit.isSuccess(decodeStyalProjectFileAction(candidate)) ? candidate : null;
}

function recoverFile(record: JsonRecord): StyalProjectFile {
  // Actions recover one by one, so a bad action or an over-long list does not
  // discard the valid ones.
  const { actions: rawActions, ...fields } = record;
  const decodedActions = decodeJsonArray(rawActions);
  const actions = Exit.isSuccess(decodedActions)
    ? decodedActions.value
        .map(recoverAction)
        .filter((action) => action !== null)
        .slice(0, STYAL_PROJECT_FILE_MAX_ACTIONS)
    : undefined;
  const candidate = {
    ...pickValidFields(fields, FILE_FIELDS),
    ...(actions === undefined ? {} : { actions }),
  };
  // Every field in the candidate validated alone, and the struct has no
  // cross-field rules, so this decode only applies the field transformations.
  const decoded = decodeStyalProjectFile(candidate);
  return Exit.isSuccess(decoded) ? decoded.value : {};
}

function hasUnknownFileKeys(record: JsonRecord): boolean {
  if (hasUnknownKeys(record, FILE_FIELDS)) return true;
  const decodedActions = decodeJsonArray(record.actions);
  if (Exit.isFailure(decodedActions)) return false;
  return decodedActions.value.some((action) => {
    const decodedAction = decodeJsonObject(action);
    return Exit.isSuccess(decodedAction) && hasUnknownKeys(decodedAction.value, ACTION_FIELDS);
  });
}

/**
 * Decode raw `styal.json` contents and report whether invalid or unrecognized
 * fields had to be discarded. Syntax errors and non-object roots are invalid
 * because their fields cannot be recovered independently.
 */
export function parseStyalProjectFileResult(contents: string): StyalProjectFileParseResult {
  const decodedJson = decodeLenientJson(contents);
  if (Exit.isFailure(decodedJson)) return { status: "invalid", file: null };
  const decodedRecord = decodeJsonObject(decodedJson.value);
  if (Exit.isFailure(decodedRecord)) return { status: "invalid", file: null };

  const decoded = decodeStyalProjectFile(decodedRecord.value);
  if (Exit.isSuccess(decoded)) {
    return {
      status: hasUnknownFileKeys(decodedRecord.value) ? "partial" : "valid",
      file: decoded.value,
    };
  }
  return { status: "partial", file: recoverFile(decodedRecord.value) };
}

/**
 * What styal makes of a project's checked-in configuration.
 *
 * - `missing`: neither `styal.json` nor `t3.json` is readable.
 * - `invalid`: the file in effect is malformed or its root is not an object.
 *   An invalid `styal.json` still hides `t3.json`, so fixing the new file is
 *   never silently undone by the old one.
 * - `partial`: the file decoded after invalid or unknown fields were ignored.
 * - `valid`: the file decoded cleanly.
 *
 * `legacyScripts` carries a `t3.json`'s scripts, which styal never runs; the
 * migration to `styal.json` offers them instead.
 */
export type ProjectConfigState =
  | { readonly status: "missing"; readonly config: null; readonly legacyScripts: readonly [] }
  | {
      readonly status: "invalid";
      readonly source: ProjectConfig["source"];
      readonly config: null;
      readonly legacyScripts: readonly [];
    }
  | {
      readonly status: "valid" | "partial";
      readonly source: ProjectConfig["source"];
      readonly config: ProjectConfig;
      readonly legacyScripts: ReadonlyArray<T3ProjectFileScript>;
    };

const MISSING: ProjectConfigState = { status: "missing", config: null, legacyScripts: [] };

/**
 * Resolve the project configuration from the raw contents of both files
 * (null when a file is missing or unreadable). `styal.json` wins whenever it
 * exists; `t3.json` is consulted only without one.
 */
export function resolveProjectConfig(files: {
  readonly styal: string | null;
  readonly t3: string | null;
}): ProjectConfigState {
  if (files.styal !== null) {
    const parsed = parseStyalProjectFileResult(files.styal);
    if (parsed.status === "invalid") {
      return {
        status: "invalid",
        source: STYAL_PROJECT_FILE_NAME,
        config: null,
        legacyScripts: [],
      };
    }
    const { $schema: _schema, actions, ...settings } = parsed.file;
    return {
      status: parsed.status,
      source: STYAL_PROJECT_FILE_NAME,
      config: { ...settings, source: STYAL_PROJECT_FILE_NAME, actions: withActionIds(actions) },
      legacyScripts: [],
    };
  }
  if (files.t3 !== null) {
    const parsed = parseT3ProjectFileResult(files.t3);
    if (parsed.status === "invalid") {
      return { status: "invalid", source: "t3.json", config: null, legacyScripts: [] };
    }
    const { $schema: _schema, scripts, ...settings } = parsed.file;
    return {
      status: parsed.status,
      source: "t3.json",
      config: { ...settings, source: "t3.json", actions: [] },
      legacyScripts: scripts ?? [],
    };
  }
  return MISSING;
}

/**
 * File actions with every id filled in. An explicit id is kept as written;
 * the first action to claim an id keeps it and a later duplicate is dropped,
 * because two actions sharing an id cannot both be bound or overridden.
 * Missing ids derive from the name, avoiding ids already taken.
 */
function withActionIds(
  actions: ReadonlyArray<StyalProjectFileAction> | undefined,
): ReadonlyArray<ProjectConfigAction> {
  if (actions === undefined) return [];
  const explicit = new Set<string>();
  const kept = actions.filter((action) => {
    if (action.id === undefined) return true;
    if (explicit.has(action.id)) return false;
    explicit.add(action.id);
    return true;
  });
  const taken = new Set(explicit);
  return kept.map((action) => {
    const id = action.id ?? nextProjectScriptId(action.name, taken);
    taken.add(id);
    return { ...action, id, icon: action.icon ?? "play" };
  });
}

/**
 * Build the publishable JSON Schema document for `styal.json` (draft 2020-12),
 * served at {@link STYAL_PROJECT_FILE_SCHEMA_URL} so editors get completion
 * via a `$schema` reference.
 */
export function buildStyalProjectFileJsonSchema(): Record<string, unknown> {
  // Closed objects so editors flag unknown keys.
  const document = Schema.toJsonSchemaDocument(StyalProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: STYAL_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
