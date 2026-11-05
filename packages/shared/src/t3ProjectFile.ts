import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  T3ProjectFile,
  T3ProjectFileScript,
  T3_PROJECT_FILE_MAX_SCRIPTS,
  T3_PROJECT_FILE_SCHEMA_URL,
} from "@t3tools/contracts";

import {
  makeFieldValidators,
  recoverProjectFile,
  type ProjectFileIssue,
} from "./projectFileRecovery.ts";
import { fromLenientJson } from "./schemaJson.ts";

export const T3ProjectFileFromJson = fromLenientJson(T3ProjectFile);

const decodeT3ProjectFileValue = Schema.decodeUnknownExit(T3ProjectFile);
const decodeJsonObject = Schema.decodeUnknownExit(Schema.Record(Schema.String, Schema.Unknown));
const decodeLenientJson = Schema.decodeExit(fromLenientJson(Schema.Unknown));

const PROJECT_FILE_SHAPE = {
  fields: makeFieldValidators(T3ProjectFile.fields),
  list: {
    key: "scripts",
    label: "Script",
    fields: makeFieldValidators(T3ProjectFileScript.fields),
    max: T3_PROJECT_FILE_MAX_SCRIPTS,
  },
};

export type T3ProjectFileParseResult =
  | {
      readonly status: "valid" | "partial";
      readonly file: T3ProjectFile;
      readonly issues: ReadonlyArray<ProjectFileIssue>;
    }
  | { readonly status: "invalid"; readonly file: null };

/**
 * Decode raw `t3.json` contents and report each invalid or unrecognized value
 * and each script that had to be discarded. Syntax errors and non-object roots
 * remain invalid because their fields cannot be recovered independently.
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

  const { candidate, issues } = recoverProjectFile(decodedRecord.value, PROJECT_FILE_SHAPE);
  // Every value in the candidate validated alone, and the struct has no
  // cross-field rules, so this decode only applies the field transformations.
  const decoded = decodeT3ProjectFileValue(candidate);
  return {
    status: issues.length === 0 ? "valid" : "partial",
    file: Exit.isSuccess(decoded) ? decoded.value : {},
    issues,
  };
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
