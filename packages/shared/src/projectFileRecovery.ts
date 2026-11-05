/**
 * Field-by-field recovery for checked-in project files, so one invalid value
 * does not hide the rest of the file. Shared by `styal.json` and `t3.json`.
 */
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

export type JsonRecord = Readonly<Record<string, unknown>>;

interface FieldValidator {
  readonly required: boolean;
  /** Why the value is invalid, or null when it is valid. */
  readonly problem: (value: unknown) => string | null;
}
export type FieldValidators = ReadonlyMap<string, FieldValidator>;

/** Something in a project file that was ignored, and why. */
export interface ProjectFileIssue {
  /** Where the value sits in the file, such as `["actions", 1, "icon"]`. */
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

/** The `actions` or `scripts` list of a project file, whose entries recover one by one. */
export interface ProjectFileList {
  readonly key: string;
  /** What to call one entry in an issue message. */
  readonly label: string;
  readonly fields: FieldValidators;
  readonly max: number;
  /** A field no two entries may share; the first entry with a value keeps it. */
  readonly uniqueKey?: string;
}

const decodeJsonObject = Schema.decodeUnknownExit(Schema.Record(Schema.String, Schema.Unknown));

/**
 * One validator per field of a struct schema, keyed by field name. Recovery
 * and its issues read their keys from here, so a field added to the contract
 * is recovered without touching this file.
 */
export function makeFieldValidators(fields: {
  readonly [key: string]: Schema.Top & { readonly DecodingServices: never };
}): FieldValidators {
  return new Map(
    Object.entries(fields).map(([key, field]) => {
      const decode = Schema.decodeUnknownExit(Schema.Struct({ [key]: field }));
      return [
        key,
        {
          required: !SchemaAST.isOptional(field.ast),
          problem: (value: unknown) => {
            const exit = decode({ [key]: value });
            if (Exit.isSuccess(exit)) return null;
            // The second line of a schema error is only the path, which the issue already has.
            return Cause.pretty(exit.cause)
              .replace(/^SchemaError: /, "")
              .replace(/\n[\s\S]*/, "");
          },
        },
      ];
    }),
  );
}

function entryLabel(record: JsonRecord, index: number, list: ProjectFileList): string {
  const name = typeof record.name === "string" ? record.name.trim() : "";
  return `${list.label} ${name === "" ? index + 1 : JSON.stringify(name)}`;
}

/** An entry without its invalid optional fields, or null when the whole entry is dropped. */
function recoverEntry(
  entry: unknown,
  index: number,
  list: ProjectFileList,
  issues: Array<ProjectFileIssue>,
): JsonRecord | null {
  const path = [list.key, index];
  const decoded = decodeJsonObject(entry);
  if (Exit.isFailure(decoded)) {
    issues.push({ path, message: `${list.label} ${index + 1} was dropped: it is not an object` });
    return null;
  }
  const record = decoded.value;
  const label = entryLabel(record, index, list);

  const kept: Record<string, unknown> = {};
  const fieldIssues: Array<ProjectFileIssue> = [];
  let dropReason: string | null = null;
  for (const [key, value] of Object.entries(record)) {
    const field = list.fields.get(key);
    const problem = field?.problem(value) ?? null;
    if (field === undefined) {
      fieldIssues.push({
        path: [...path, key],
        message: `${label}: "${key}" is not a known field`,
      });
    } else if (problem === null) {
      kept[key] = value;
    } else if (field.required) {
      dropReason ??= `"${key}" is invalid: ${problem}`;
    } else {
      fieldIssues.push({
        path: [...path, key],
        message: `${label}: "${key}" is invalid: ${problem}`,
      });
    }
  }
  for (const [key, field] of list.fields) {
    if (field.required && !Object.hasOwn(record, key)) {
      dropReason ??= `"${key}" is missing`;
    }
  }
  if (dropReason !== null) {
    issues.push({ path, message: `${label} was dropped: ${dropReason}` });
    return null;
  }
  issues.push(...fieldIssues);
  return kept;
}

function recoverList(
  entries: ReadonlyArray<unknown>,
  list: ProjectFileList,
  issues: Array<ProjectFileIssue>,
): ReadonlyArray<JsonRecord> {
  const kept: Array<JsonRecord> = [];
  const claimed = new Set<unknown>();
  let recovered = 0;
  for (const [index, entry] of entries.entries()) {
    if (recovered === list.max) {
      issues.push({
        path: [list.key, index],
        message: `Only the first ${list.max} ${list.label.toLowerCase()}s are used, so this one and any after it were dropped`,
      });
      break;
    }
    const recoveredEntry = recoverEntry(entry, index, list, issues);
    if (recoveredEntry === null) continue;
    recovered += 1;
    const unique = list.uniqueKey === undefined ? undefined : recoveredEntry[list.uniqueKey];
    if (list.uniqueKey !== undefined && unique !== undefined && claimed.has(unique)) {
      issues.push({
        path: [list.key, index, list.uniqueKey],
        message: `${entryLabel(recoveredEntry, index, list)} was dropped: ${list.uniqueKey} "${String(unique)}" is already used`,
      });
      continue;
    }
    claimed.add(unique);
    kept.push(recoveredEntry);
  }
  return kept;
}

/**
 * The fields of `record` that are valid on their own, still encoded, and an
 * issue for everything left out, in file order. A file with no issues is
 * valid, so what recovery drops and what the warning lists cannot disagree.
 */
export function recoverProjectFile(
  record: JsonRecord,
  shape: { readonly fields: FieldValidators; readonly list: ProjectFileList },
): { readonly candidate: JsonRecord; readonly issues: ReadonlyArray<ProjectFileIssue> } {
  const candidate: Record<string, unknown> = {};
  const issues: Array<ProjectFileIssue> = [];
  for (const [key, value] of Object.entries(record)) {
    const field = shape.fields.get(key);
    if (field === undefined) {
      issues.push({ path: [key], message: `"${key}" is not a known field` });
    } else if (key === shape.list.key && Array.isArray(value)) {
      candidate[key] = recoverList(value, shape.list, issues);
    } else {
      const problem = field.problem(value);
      if (problem === null) {
        candidate[key] = value;
      } else {
        issues.push({ path: [key], message: `"${key}" is invalid: ${problem}` });
      }
    }
  }
  return { candidate, issues };
}
