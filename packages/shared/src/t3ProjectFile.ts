import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  T3ProjectFile,
  T3ProjectFileScript,
  T3_PROJECT_FILE_MAX_SCRIPTS,
  T3_PROJECT_FILE_SCHEMA_URL,
} from "@t3tools/contracts";

import {
  hasUnknownKeys,
  makeFieldValidators,
  pickValidFields,
  type JsonRecord,
} from "./projectFileRecovery.ts";
import { fromLenientJson } from "./schemaJson.ts";

export const T3ProjectFileFromJson = fromLenientJson(T3ProjectFile);

const decodeT3ProjectFileValue = Schema.decodeUnknownExit(T3ProjectFile);
const decodeT3ProjectFileScript = Schema.decodeUnknownExit(T3ProjectFileScript);
const decodeJsonObject = Schema.decodeUnknownExit(Schema.Record(Schema.String, Schema.Unknown));
const decodeJsonArray = Schema.decodeUnknownExit(Schema.Array(Schema.Unknown));
const decodeLenientJson = Schema.decodeExit(fromLenientJson(Schema.Unknown));

const PROJECT_FILE_FIELDS = makeFieldValidators(T3ProjectFile.fields);
const PROJECT_FILE_SCRIPT_FIELDS = makeFieldValidators(T3ProjectFileScript.fields);

export type T3ProjectFileParseResult =
  | { readonly status: "valid"; readonly file: T3ProjectFile }
  | { readonly status: "partial"; readonly file: T3ProjectFile }
  | { readonly status: "invalid"; readonly file: null };

/** A script without its invalid optional fields, or null when a required field is invalid. */
function recoverScript(input: unknown): JsonRecord | null {
  const decodedRecord = decodeJsonObject(input);
  if (Exit.isFailure(decodedRecord)) {
    return null;
  }
  const candidate = pickValidFields(decodedRecord.value, PROJECT_FILE_SCRIPT_FIELDS);
  return Exit.isSuccess(decodeT3ProjectFileScript(candidate)) ? candidate : null;
}

function recoverScripts(inputs: ReadonlyArray<unknown>): ReadonlyArray<JsonRecord> {
  const scripts: Array<JsonRecord> = [];
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

function recoverProjectFile(record: JsonRecord): T3ProjectFile {
  // Scripts recover one by one, so a bad script or an over-long list does not
  // discard the valid ones.
  const { scripts: rawScripts, ...fields } = record;
  const decodedScripts = decodeJsonArray(rawScripts);
  const candidate = {
    ...pickValidFields(fields, PROJECT_FILE_FIELDS),
    ...(Exit.isSuccess(decodedScripts) ? { scripts: recoverScripts(decodedScripts.value) } : {}),
  };
  // Every field in the candidate validated alone, and the struct has no
  // cross-field rules, so this decode only applies the field transformations.
  const decoded = decodeT3ProjectFileValue(candidate);
  return Exit.isSuccess(decoded) ? decoded.value : {};
}

function hasUnknownProjectFileKeys(record: JsonRecord): boolean {
  if (hasUnknownKeys(record, PROJECT_FILE_FIELDS)) {
    return true;
  }
  const decodedScripts = decodeJsonArray(record.scripts);
  if (Exit.isFailure(decodedScripts)) {
    return false;
  }
  return decodedScripts.value.some((script) => {
    const decodedScript = decodeJsonObject(script);
    return (
      Exit.isSuccess(decodedScript) &&
      hasUnknownKeys(decodedScript.value, PROJECT_FILE_SCRIPT_FIELDS)
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

export function buildT3ProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(T3ProjectFile, { onExcessProperty: "error" });
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
