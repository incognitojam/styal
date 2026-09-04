import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { StyalProjectFile, STYAL_PROJECT_FILE_SCHEMA_URL } from "@t3tools/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `styal.json` file contents (lenient JSONC string) and the
 * decoded {@link StyalProjectFile}.
 */
export const StyalProjectFileFromJson = fromLenientJson(StyalProjectFile);

const decodeStyalProjectFile = Schema.decodeExit(StyalProjectFileFromJson);

/**
 * Decode raw `styal.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseStyalProjectFile(contents: string): StyalProjectFile | null {
  const decoded = decodeStyalProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/**
 * Build the publishable JSON Schema document for `styal.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link STYAL_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildStyalProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(StyalProjectFile);
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
