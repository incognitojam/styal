import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { T3ProjectFile, T3_PROJECT_FILE_SCHEMA_URL } from "@t3tools/contracts";

import { fromLenientJson } from "./schemaJson.ts";

export const T3ProjectFileFromJson = fromLenientJson(T3ProjectFile).check(
  Schema.makeFilter((file) => {
    for (const action of file.scripts ?? []) {
      const hidden = action.command.match(
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]|\r(?!\n)/,
      );
      if (hidden)
        return `Action "${action.name}" command contains disallowed character U+${hidden[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
    }
    return true;
  }),
);

const decodeT3ProjectFile = Schema.decodeExit(T3ProjectFileFromJson);

export function parseT3ProjectFile(contents: string): T3ProjectFile | null {
  const decoded = decodeT3ProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
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
