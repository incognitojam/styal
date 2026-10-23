import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";

import { relayResourceNameForStage } from "./deploymentConfig.ts";

const relayRecentSpansQuery = (dataset: string) =>
  [
    `['${dataset}']`,
    `| where isnotnull(span_id) or isnotnull(trace_id)`,
    `| extend requestMethod = column_ifexists('attributes.http.request.method', ''), path = column_ifexists('attributes.url.path', ''), endpoint = column_ifexists('attributes.http.route', ''), statusCode = column_ifexists('attributes.http.response.status_code', 0), customAttributes = column_ifexists('attributes.custom', dynamic({}))`,
    `| extend userId = customAttributes['user']['id']`,
    `| project _time, name, trace_id, span_id, duration, requestMethod, path, statusCode, endpoint, userId`,
    `| order by _time desc`,
    `| limit 200`,
  ].join("\n");

export const RelayObservability = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const traces = yield* Axiom.Dataset("RelayTracesDataset", {
    name: relayResourceNameForStage("t3-code-relay-traces", stage),
    kind: "otel:traces:v1",
    description: "styal relay Worker HTTP request spans.",
    retentionDays: 30,
    useRetentionPeriod: true,
  });

  const workerIngestToken = yield* Axiom.ApiToken("RelayWorkerAxiomIngestToken", {
    name: relayResourceNameForStage("t3-code-relay-otel-ingest", stage),
    description: "Owned by Alchemy. Scoped OTLP ingest token for relay HTTP spans.",
    datasetCapabilities: Output.map(traces.name, (dataset) => ({
      [dataset]: { ingest: ["create" as const] },
    })),
  });

  const mobileIngestToken = yield* Axiom.ApiToken("RelayMobileAxiomIngestToken", {
    name: relayResourceNameForStage("t3-code-mobile-otel-ingest", stage),
    description: "Owned by Alchemy. Scoped OTLP ingest token for styal mobile spans.",
    datasetCapabilities: Output.map(traces.name, (dataset) => ({
      [dataset]: { ingest: ["create" as const] },
    })),
  });

  const clientIngestToken = yield* Axiom.ApiToken("RelayClientAxiomIngestToken", {
    name: relayResourceNameForStage("t3-code-relay-client-otel-ingest", stage),
    description: "Owned by Alchemy. Scoped OTLP ingest token for first-party relay client spans.",
    datasetCapabilities: Output.map(traces.name, (dataset) => ({
      [dataset]: { ingest: ["create" as const] },
    })),
  });

  yield* Axiom.View("RelayRecentSpansView", {
    name: relayResourceNameForStage("t3-code-relay-recent-spans", stage),
    description: "Recent relay HTTP request spans.",
    datasets: [traces.name],
    aplQuery: Output.map(traces.name, relayRecentSpansQuery),
  });

  return { traces, workerIngestToken, mobileIngestToken, clientIngestToken } as const;
});

export const withSpanAttributes =
  (attributes: Record<string, unknown>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.annotateCurrentSpan(attributes).pipe(
      Effect.andThen(effect.pipe(Effect.annotateSpans(attributes))),
    );

/**
 * Error fields never copied onto spans. Database errors carry their query's
 * bound values as `params` and the offending row as `detail`, which include
 * emails, push tokens and other account data; the query text itself is kept.
 */
const OMITTED_ERROR_FIELDS = new Set(["params", "detail"]);

const appendEncodedAttributes = (
  attributes: Record<string, unknown>,
  prefix: string,
  value: unknown,
): void => {
  if (OMITTED_ERROR_FIELDS.has(prefix.slice(prefix.lastIndexOf(".") + 1))) {
    return;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    attributes[prefix] = value;
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  // Arrays are walked like objects so omitted fields inside them stay out.
  for (const [key, child] of Object.entries(value)) {
    appendEncodedAttributes(attributes, `${prefix}.${key}`, child);
  }
};

const DRIVER_ERROR_TAGS = new Set([
  "EffectDrizzleQueryError",
  "EffectDrizzleError",
  "DrizzleQueryError",
  "SqlError",
]);

const isDriverError = (value: object): boolean => {
  const tag = Reflect.get(value, "_tag") ?? Reflect.get(value, "name");
  // Summaries such as persistenceCause's `{ name, code }` are already safe.
  if (
    typeof tag === "string" &&
    DRIVER_ERROR_TAGS.has(tag) &&
    (value instanceof Error || "cause" in value || "query" in value || "reason" in value)
  ) {
    return true;
  }
  // A Postgres server error, such as the cause inside an SqlError.
  return (
    typeof Reflect.get(value, "severity") === "string" &&
    typeof Reflect.get(value, "code") === "string"
  );
};

/**
 * What a span keeps of a database driver error: its kind, query text and the
 * Postgres SQL state and constraint. Driver messages and stacks embed bound
 * values (`params: …`) and failing rows, so neither is kept.
 */
export class ScrubbedDatabaseError extends Error {
  readonly query: string | undefined;
  readonly sqlState: string | undefined;
  readonly constraint: string | undefined;

  constructor(driver: string, details: { query?: string; sqlState?: string; constraint?: string }) {
    super(
      `${driver} failed${details.sqlState ? ` (SQLSTATE ${details.sqlState})` : ""}${
        details.query ? `: ${details.query}` : ""
      }`,
    );
    this.name = driver;
    this.query = details.query;
    this.sqlState = details.sqlState;
    this.constraint = details.constraint;
    this.stack = `${this.name}: ${this.message}`;
  }
}

const findDriverDetail = (value: unknown, key: string, depth = 0): string | undefined => {
  if (typeof value !== "object" || value === null || depth > 6) return undefined;
  if (Cause.isCause(value)) {
    for (const reason of value.reasons) {
      const found = findDriverDetail(
        Cause.isFailReason(reason)
          ? reason.error
          : Cause.isDieReason(reason)
            ? reason.defect
            : undefined,
        key,
        depth + 1,
      );
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof Reflect.get(value, "severity") === "string") {
    const found = Reflect.get(value, key);
    if (typeof found === "string") return found;
  }
  for (const child of ["cause", "reason"]) {
    const found = findDriverDetail(Reflect.get(value, child), key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
};

const scrubDriverError = (error: object): ScrubbedDatabaseError => {
  const tag = Reflect.get(error, "_tag") ?? Reflect.get(error, "name");
  const query = Reflect.get(error, "query");
  const sqlState = findDriverDetail(error, "code");
  const constraint = findDriverDetail(error, "constraint");
  return new ScrubbedDatabaseError(typeof tag === "string" ? tag : "DatabaseError", {
    ...(typeof query === "string" ? { query } : {}),
    ...(sqlState ? { sqlState } : {}),
    ...(constraint ? { constraint } : {}),
  });
};

const MAX_SCRUB_DEPTH = 8;

/**
 * Replaces driver errors anywhere inside a failure (error fields, `cause`
 * chains and nested Causes) with ScrubbedDatabaseError. Unchanged values keep
 * their identity; changed errors are copied with the same prototype so schema
 * encoding and `instanceof` still work.
 */
const scrubFailure = (value: unknown, depth = 0): unknown => {
  if (typeof value !== "object" || value === null || depth > MAX_SCRUB_DEPTH) return value;
  if (Cause.isCause(value)) {
    let changed = false;
    const reasons = value.reasons.map((reason) => {
      const original = Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined;
      if (original === undefined) return reason;
      const scrubbed = scrubFailure(original, depth + 1);
      if (scrubbed === original) return reason;
      changed = true;
      const next = Cause.isFailReason(reason)
        ? Cause.makeFailReason(scrubbed)
        : Cause.makeDieReason(scrubbed);
      return next.annotate(Cause.reasonAnnotations(reason));
    });
    return changed ? Cause.fromReasons(reasons) : value;
  }
  if (isDriverError(value)) return scrubDriverError(value);
  if (Array.isArray(value)) {
    const next = value.map((child) => scrubFailure(child, depth + 1));
    return next.some((child, index) => child !== value[index]) ? next : value;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  let changed = false;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "stack" || key === "message" || !("value" in descriptor)) continue;
    const scrubbed = scrubFailure(descriptor.value, depth + 1);
    if (scrubbed !== descriptor.value) {
      descriptor.value = scrubbed;
      changed = true;
    }
  }
  return changed ? Object.create(Object.getPrototypeOf(value), descriptors) : value;
};

/** The exit a span records, with database driver detail removed. */
export const scrubSpanExit = (exit: Exit.Exit<unknown, unknown>): Exit.Exit<unknown, unknown> => {
  if (Exit.isSuccess(exit)) return exit;
  const cause = scrubFailure(exit.cause) as Cause.Cause<unknown>;
  return cause === exit.cause ? exit : Exit.failCause(cause);
};

const schemaErrorAttributes = (error: unknown): Record<string, unknown> | undefined => {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const constructor = error.constructor;
  if (!Schema.isSchema(constructor)) {
    return undefined;
  }
  const encoded = Schema.encodeUnknownOption(constructor as unknown as Schema.Encoder<unknown>)(
    error,
  );
  if (Option.isNone(encoded) || typeof encoded.value !== "object" || encoded.value === null) {
    return undefined;
  }
  const tag = Reflect.get(encoded.value, "_tag");
  if (typeof tag !== "string") {
    return undefined;
  }

  const attributes: Record<string, unknown> = {
    "error.type": tag,
  };
  for (const [key, value] of Object.entries(encoded.value)) {
    if (key !== "_tag") {
      appendEncodedAttributes(attributes, `error.${key}`, value);
    }
  }
  return attributes;
};

const scrubbedDatabaseErrorAttributes = (error: ScrubbedDatabaseError) => ({
  "error.type": error.name,
  ...(error.query ? { "error.query": error.query } : {}),
  ...(error.sqlState ? { "error.sql_state": error.sqlState } : {}),
  ...(error.constraint ? { "error.constraint": error.constraint } : {}),
});

const annotateSchemaError = (span: Tracer.Span, exit: Exit.Exit<unknown, unknown>): void => {
  if (Exit.isSuccess(exit)) {
    return;
  }
  for (const reason of exit.cause.reasons) {
    const error = Cause.isFailReason(reason)
      ? reason.error
      : Cause.isDieReason(reason)
        ? reason.defect
        : undefined;
    const attributes =
      error instanceof ScrubbedDatabaseError
        ? scrubbedDatabaseErrorAttributes(error)
        : schemaErrorAttributes(error);
    if (attributes) {
      for (const [key, value] of Object.entries(attributes)) {
        span.attribute(key, value);
      }
      return;
    }
  }
};

class RelayTraceSpan implements Tracer.Span {
  readonly _tag = "Span";
  private readonly delegate: Tracer.Span;

  constructor(delegate: Tracer.Span) {
    this.delegate = delegate;
  }

  get name() {
    return this.delegate.name;
  }
  get spanId() {
    return this.delegate.spanId;
  }
  get traceId() {
    return this.delegate.traceId;
  }
  get parent() {
    return this.delegate.parent;
  }
  get annotations() {
    return this.delegate.annotations;
  }
  get status() {
    return this.delegate.status;
  }
  get attributes() {
    return this.delegate.attributes;
  }
  get links() {
    return this.delegate.links;
  }
  get sampled() {
    return this.delegate.sampled;
  }
  get kind() {
    return this.delegate.kind;
  }

  // The delegate's exporter turns the exit into `exception` events and the
  // status message, so it receives the scrubbed exit too.
  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    const scrubbed = scrubSpanExit(exit);
    annotateSchemaError(this.delegate, scrubbed);
    this.delegate.end(endTime, scrubbed);
  }

  attribute(key: string, value: unknown): void {
    this.delegate.attribute(key, value);
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    this.delegate.event(name, startTime, attributes);
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.delegate.addLinks(links);
  }
}

const withSchemaErrorAttributes = (delegate: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span: (options) => new RelayTraceSpan(delegate.span(options)),
    ...(delegate.context ? { context: delegate.context } : {}),
  });

/**
 * Adds a failed span's schema error fields (`error.type`, `error.<field>`) to
 * the span, on whichever tracer is current, and removes database driver
 * detail from the exit the exporter records. Provide it around the work whose
 * spans should carry them; the Worker's telemetry still owns export.
 */
export const withSchemaErrorSpanAttributes = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.tracer, (tracer) =>
    effect.pipe(Effect.withTracer(withSchemaErrorAttributes(tracer))),
  );
