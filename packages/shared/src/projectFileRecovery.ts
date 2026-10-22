/**
 * Field-by-field recovery for checked-in project files, so one invalid value
 * does not hide the rest of the file. Shared by `styal.json` and `t3.json`.
 */
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

export type JsonRecord = Readonly<Record<string, unknown>>;
export type FieldValidators = ReadonlyMap<string, (value: unknown) => boolean>;

/**
 * One validator per field of a struct schema, keyed by field name. Recovery
 * and unknown-key detection read their keys from here, so a field added to
 * the contract is recovered without touching this file.
 */
export function makeFieldValidators(fields: {
  readonly [key: string]: Schema.Top & { readonly DecodingServices: never };
}): FieldValidators {
  return new Map(
    Object.entries(fields).map(([key, field]) => {
      const decode = Schema.decodeUnknownExit(Schema.Struct({ [key]: field }));
      return [key, (value: unknown) => Exit.isSuccess(decode({ [key]: value }))];
    }),
  );
}

/** The known fields of `record` that are valid on their own, still encoded. */
export function pickValidFields(
  record: JsonRecord,
  validators: FieldValidators,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (validators.get(key)?.(value) === true) {
      picked[key] = value;
    }
  }
  return picked;
}

export function hasUnknownKeys(record: JsonRecord, known: FieldValidators): boolean {
  return Object.keys(record).some((key) => !known.has(key));
}
