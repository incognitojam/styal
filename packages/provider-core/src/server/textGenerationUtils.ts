import { TextGenerationError } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const isTextGenerationError = Schema.is(TextGenerationError);
const RATE_LIMIT_MESSAGE =
  /\b(?:rate[ _-]?limit(?:ed|ing|exceeded|_exceeded)?|usage[ _-]?limit(?:exceeded|_exceeded)?|too many requests|hit your (?:(?:session|weekly) )?limit|insufficient_quota|quota[ _-]exceeded|resource_exhausted)\b/i;
const decodeCliJson = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));
const isClaudeErrorResult = Schema.is(
  Schema.Struct({
    type: Schema.Literals(["result"]),
    is_error: Schema.Literals([true]),
    api_error_status: Schema.optionalKey(Schema.Unknown),
    result: Schema.optionalKey(Schema.String),
  }),
);

/** Inspect error fields, excluding validation inputs and Codex's echoed prompt. */
export function isTextGenerationRateLimitError(error: TextGenerationError): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      const claudePrefix = "Claude CLI command failed:";
      const claudeOffset = value.indexOf(claudePrefix);
      if (claudeOffset !== -1) {
        const decoded = decodeCliJson(value.slice(claudeOffset + claudePrefix.length).trim());
        if (Option.isSome(decoded)) {
          // Verbose output can echo prompts and successful messages; only inspect failed results.
          const messages: ReadonlyArray<unknown> = Array.isArray(decoded.value)
            ? decoded.value
            : [decoded.value];
          for (const message of messages) {
            if (isClaudeErrorResult(message)) {
              pending.push({ status: message.api_error_status, message: message.result });
            }
          }
          continue;
        }
      }
      const prefix = "Codex CLI command failed:";
      const offset = value.indexOf(prefix);
      const detail =
        offset === -1
          ? value
          : (value
              .slice(offset + prefix.length)
              .split("\n")
              .findLast((line) => line.trimStart().startsWith("ERROR:")) ?? "");
      if (RATE_LIMIT_MESSAGE.test(detail)) return true;
    } else if (value !== null && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      const field = (key: string): unknown => Reflect.get(value, key);
      if (field("_tag") === "SchemaError") continue;
      if (
        ["status", "statusCode", "code"]
          .map(field)
          .some((status) => status === 429 || status === "429")
      )
        return true;
      pending.push(...["detail", "message", "errorMessage", "code", "data", "cause"].map(field));
    }
  }
  return false;
}
const decodeJsonThreadTitle = Schema.decodeOption(
  Schema.fromJsonString(Schema.Struct({ title: Schema.String })),
);

export function toJsonSchemaObject(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(Schema.toType(schema), {
    onExcessProperty: "error",
  });
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return { ...document.schema, $defs: document.definitions };
  }
  return document.schema;
}

export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    withoutTrailingPeriod,
  );
  let subject = "";
  for (const { segment } of segments) {
    if (subject.length + segment.length > 72) break;
    subject += segment;
  }
  return subject.trimEnd() || "Update project files";
}

export function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

const MAX_THREAD_TITLE_CHARS = 120;

export function sanitizeThreadTitle(raw: string): string {
  // Unwrap a JSON-formatted title before truncation can cut off the closing brace.
  const decoded = decodeJsonThreadTitle(raw);
  const title = Option.isSome(decoded) ? decoded.value.title : raw;
  const normalized = title
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized || normalized.trim().length === 0) {
    return "New thread";
  }

  if (normalized.length <= MAX_THREAD_TITLE_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_THREAD_TITLE_CHARS - 3).trimEnd()}...`;
}

function cliLabel(cliName: string): string {
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1);
  return `${capitalized} CLI (\`${cliName}\`)`;
}

export function normalizeCliError(
  cliName: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (isTextGenerationError(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${cliName}`) ||
      lower.includes(`spawn ${cliName}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: `${cliLabel(cliName)} is required but not available on PATH.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: fallback,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}
