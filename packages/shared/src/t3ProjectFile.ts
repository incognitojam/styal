import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  ProjectScriptIcon,
  T3ProjectFile,
  T3ProjectFileScript,
  T3_PROJECT_FILE_MAX_SCRIPTS,
  T3_PROJECT_FILE_SCHEMA_URL,
} from "@t3tools/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `t3.json` file contents (lenient JSONC string) and the
 * decoded {@link T3ProjectFile}.
 */
export const T3ProjectFileFromJson = fromLenientJson(T3ProjectFile);

const decodeT3ProjectFileValue = Schema.decodeUnknownExit(T3ProjectFile);
const decodeT3ProjectFileScript = Schema.decodeUnknownExit(T3ProjectFileScript);
const decodeProjectScriptIcon = Schema.decodeUnknownExit(ProjectScriptIcon);
const decodeBoolean = Schema.decodeUnknownExit(Schema.Boolean);
const decodeJsonObject = Schema.decodeUnknownExit(Schema.Record(Schema.String, Schema.Unknown));
const decodeJsonArray = Schema.decodeUnknownExit(Schema.Array(Schema.Unknown));
const decodeLenientJson = Schema.decodeExit(fromLenientJson(Schema.Unknown));

const PROJECT_FILE_KEYS: ReadonlySet<string> = new Set([
  "$schema",
  "iconPath",
  "defaultThreadEnvMode",
  "scripts",
]);
const PROJECT_FILE_SCRIPT_KEYS: ReadonlySet<string> = new Set([
  "name",
  "command",
  "icon",
  "runOnWorktreeCreate",
]);

export type T3ProjectFileParseResult =
  | { readonly status: "valid"; readonly file: T3ProjectFile }
  | { readonly status: "partial"; readonly file: T3ProjectFile }
  | { readonly status: "invalid"; readonly file: null };

function recoverScript(input: unknown): T3ProjectFileScript | null {
  const decodedRecord = decodeJsonObject(input);
  if (Exit.isFailure(decodedRecord)) {
    return null;
  }

  const record = decodedRecord.value;
  const decodedIcon = decodeProjectScriptIcon(record.icon);
  const decodedRunOnWorktreeCreate = decodeBoolean(record.runOnWorktreeCreate);
  const candidate = {
    name: record.name,
    command: record.command,
    ...(Exit.isSuccess(decodedIcon) ? { icon: decodedIcon.value } : {}),
    ...(Exit.isSuccess(decodedRunOnWorktreeCreate)
      ? { runOnWorktreeCreate: decodedRunOnWorktreeCreate.value }
      : {}),
  };
  const decoded = decodeT3ProjectFileScript(candidate);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

function recoverScripts(inputs: ReadonlyArray<unknown>): ReadonlyArray<T3ProjectFileScript> {
  const scripts: Array<T3ProjectFileScript> = [];
  for (const input of inputs) {
    const script = recoverScript(input);
    if (script !== null) {
      scripts.push(script);
    }
    if (scripts.length === T3_PROJECT_FILE_MAX_SCRIPTS) {
      break;
    }
  }
  return scripts;
}

function recoverProjectFile(record: Readonly<Record<string, unknown>>): T3ProjectFile {
  const schemaField = decodeT3ProjectFileValue({ $schema: record.$schema });
  const iconPathField = decodeT3ProjectFileValue({ iconPath: record.iconPath });
  const defaultThreadEnvModeField = decodeT3ProjectFileValue({
    defaultThreadEnvMode: record.defaultThreadEnvMode,
  });
  const decodedScripts = decodeJsonArray(record.scripts);
  const scripts = Exit.isSuccess(decodedScripts) ? recoverScripts(decodedScripts.value) : undefined;

  return {
    ...(Exit.isSuccess(schemaField) ? schemaField.value : {}),
    ...(Exit.isSuccess(iconPathField) ? iconPathField.value : {}),
    ...(Exit.isSuccess(defaultThreadEnvModeField) ? defaultThreadEnvModeField.value : {}),
    ...(scripts === undefined ? {} : { scripts }),
  };
}

function hasUnknownKeys(
  record: Readonly<Record<string, unknown>>,
  knownKeys: ReadonlySet<string>,
): boolean {
  return Object.keys(record).some((key) => !knownKeys.has(key));
}

function hasUnknownProjectFileKeys(record: Readonly<Record<string, unknown>>): boolean {
  if (hasUnknownKeys(record, PROJECT_FILE_KEYS)) {
    return true;
  }
  const decodedScripts = decodeJsonArray(record.scripts);
  if (Exit.isFailure(decodedScripts)) {
    return false;
  }
  return decodedScripts.value.some((script) => {
    const decodedScript = decodeJsonObject(script);
    return (
      Exit.isSuccess(decodedScript) && hasUnknownKeys(decodedScript.value, PROJECT_FILE_SCRIPT_KEYS)
    );
  });
}

/**
 * Decode raw `t3.json` contents and report whether invalid or unrecognized
 * fields had to be discarded. Syntax errors and non-object roots remain
 * invalid because their fields cannot be recovered independently.
 */
export function parseT3ProjectFileResult(contents: string): T3ProjectFileParseResult {
  const decodedJson = decodeLenientJson(contents);
  if (Exit.isFailure(decodedJson)) {
    return { status: "invalid", file: null };
  }
  const decodedRecord = decodeJsonObject(decodedJson.value);
  if (Exit.isFailure(decodedRecord)) {
    return { status: "invalid", file: null };
  }

  const decoded = decodeT3ProjectFileValue(decodedRecord.value);
  if (Exit.isSuccess(decoded)) {
    return {
      status: hasUnknownProjectFileKeys(decodedRecord.value) ? "partial" : "valid",
      file: decoded.value,
    };
  }
  return { status: "partial", file: recoverProjectFile(decodedRecord.value) };
}

/**
 * Decode raw `t3.json` contents, preserving valid fields and scripts when
 * another value fails validation. Malformed files and non-object roots are
 * treated as absent.
 */
export function parseT3ProjectFile(contents: string): T3ProjectFile | null {
  return parseT3ProjectFileResult(contents).file;
}

/**
 * Build the publishable JSON Schema document for `t3.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link T3_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildT3ProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(T3ProjectFile);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: T3_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
