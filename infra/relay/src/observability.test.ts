import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";

import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import * as Observability from "./observability.ts";

it.effect("adds schema error fields to spans on the current tracer", () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });

    yield* Effect.fail(
      new EnvironmentConnector.EnvironmentConnectNotAuthorized({
        environmentId: "environment-1",
        operation: "connect",
        reason: "managed_endpoint_allocation_not_ready",
      }),
    ).pipe(
      Effect.withSpan("relay.test.schema_error"),
      Effect.exit,
      Observability.withSchemaErrorSpanAttributes,
      Effect.withTracer(tracer),
    );

    expect(spans.map((span) => span.name)).toEqual(["relay.test.schema_error"]);
    expect(Object.fromEntries(spans[0]!.attributes)).toMatchObject({
      "error.type": "EnvironmentConnectNotAuthorized",
      "error.environmentId": "environment-1",
      "error.operation": "connect",
      "error.reason": "managed_endpoint_allocation_not_ready",
    });
  }),
);

class QueryFailed extends Schema.TaggedError<QueryFailed>()("QueryFailed", {
  query: Schema.String,
  params: Schema.Array(Schema.String),
  cause: Schema.Struct({ params: Schema.Array(Schema.String), code: Schema.String }),
}) {}

it.effect("never copies query parameters from a failed query onto its span", () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });

    yield* Effect.fail(
      new QueryFailed({
        query: "select 1 from relay_users where email = $1",
        params: ["someone@example.com"],
        cause: { params: ["someone@example.com"], code: "57014" },
      }),
    ).pipe(
      Effect.withSpan("relay.test.query_error"),
      Effect.exit,
      Observability.withSchemaErrorSpanAttributes,
      Effect.withTracer(tracer),
    );

    const attributes = Object.fromEntries(spans[0]!.attributes);
    expect(attributes).toMatchObject({
      "error.type": "QueryFailed",
      "error.query": "select 1 from relay_users where email = $1",
      "error.cause.code": "57014",
    });
    expect(JSON.stringify(attributes)).not.toContain("someone@example.com");
  }),
);
