import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import { describe, expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as OtlpExporter from "effect/observability/OtlpExporter";
import * as OtlpSerialization from "effect/observability/OtlpSerialization";
import * as OtlpTracer from "effect/observability/OtlpTracer";

import * as RelayConfiguration from "./Config.ts";
import * as RelayDb from "./db.ts";
import * as EmailSignInCodes from "./auth/EmailSignInCodes.ts";
import * as Observability from "./observability.ts";
import { relayUsers } from "./persistence/schema.ts";
import { config } from "./test/fixtures.ts";

// Opt in with an isolated Postgres database with all relay migrations applied.
const databaseUrl = process.env.RELAY_TEST_DATABASE_URL;
const layerDb = Layer.effect(RelayDb.RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(databaseUrl ?? "postgres://unused") })),
);
const layer = EmailSignInCodes.layer.pipe(
  Layer.provideMerge(RelayConfiguration.layer(config)),
  Layer.provideMerge(layerDb),
  Layer.provideMerge(NodeCrypto.layer),
);

interface ExportedSpan {
  readonly name: string;
  readonly attributes: ReadonlyArray<unknown>;
  readonly events: ReadonlyArray<{
    readonly name: string;
    readonly attributes: ReadonlyArray<{ key: string; value: { stringValue?: string } }>;
  }>;
  readonly status: { readonly message?: string };
}

/**
 * Runs `effect` under the real OTLP exporter, as the Worker's Axiom telemetry
 * does, and returns the spans it would send.
 */
const exportSpans = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const bodies: Array<string> = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag === "Uint8Array") {
          bodies.push(new TextDecoder().decode(request.body.body));
        }
        return HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }));
      }),
    );
    const exit = yield* Effect.scoped(
      Effect.gen(function* () {
        const tracer = yield* OtlpTracer.make({
          url: "https://otlp.example.test/v1/traces",
          resource: { serviceName: "relay-test" },
        });
        const result = yield* effect.pipe(
          Effect.withSpan("relay.test.root"),
          Observability.withSchemaErrorSpanAttributes,
          Effect.withTracer(tracer),
          Effect.exit,
        );
        yield* (yield* OtlpExporter.Flusher).flush;
        return result;
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          OtlpExporter.layerFlusher,
          OtlpSerialization.layerJson,
          Layer.succeed(HttpClient.HttpClient, client),
        ),
      ),
    );
    const spans = bodies.flatMap((body) =>
      (
        JSON.parse(body) as {
          resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<ExportedSpan> }> }>;
        }
      ).resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)),
    );
    return { exit, spans, exported: bodies.join("\n") };
  });

const exceptionMessages = (spans: ReadonlyArray<ExportedSpan>, name: string) =>
  spans
    .filter((span) => span.name === name)
    .flatMap((span) => span.events)
    .filter((event) => event.name === "exception")
    .map(
      (event) =>
        event.attributes.find((attribute) => attribute.key === "exception.message")?.value
          .stringValue,
    );

describe.skipIf(!databaseUrl)("trace export of database failures (Postgres)", () => {
  it.live("a failed sign-in code insert exports no bound email", () =>
    Effect.gen(function* () {
      const codes = yield* EmailSignInCodes.EmailSignInCodes;
      // Longer than the column allows, so Postgres rejects the insert (22001)
      // after drizzle has bound the email as a parameter.
      const email = `${"leak".repeat(80)}@example.test`;
      const { exit, spans, exported } = yield* exportSpans(
        codes.issue({ email, thumbprint: "trace-test-key" }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(spans.map((span) => span.name)).toEqual(
        expect.arrayContaining([
          "sql.transaction",
          "drizzle.operation",
          "relay.sign_in_codes.issue",
        ]),
      );
      // The failure is still recorded, with its SQL state and query text.
      expect(exceptionMessages(spans, "drizzle.operation")).toEqual([
        expect.stringMatching(/^EffectDrizzleQueryError failed \(SQLSTATE 22001\): insert into/),
      ]);
      expect(exported).toContain('"error.sql_state"');
      expect(exported).not.toContain(email);
      expect(exported).not.toContain("leakleak");
    }).pipe(Effect.provide(layer)),
  );

  it.live("a unique violation exports neither the failing row nor the parameters", () =>
    Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      const crypto = yield* Crypto.Crypto;
      const email = `trace-${yield* crypto.randomUUIDv4}@example.test`;
      const now = "2026-10-18T12:00:00.000Z";
      const insert = (userId: string) =>
        db.insert(relayUsers).values({ userId, email, createdAt: now, updatedAt: now });
      const first = `usr_trace_${yield* crypto.randomUUIDv4}`;
      const second = `${first}_duplicate`;
      yield* Effect.addFinalizer(() =>
        db.delete(relayUsers).where(eq(relayUsers.email, email)).pipe(Effect.orDie),
      );
      yield* insert(first);
      const { exit, spans, exported } = yield* exportSpans(
        db.$client.withTransaction(insert(second)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(exceptionMessages(spans, "sql.transaction")).toEqual([
        expect.stringContaining("SQLSTATE 23505"),
      ]);
      expect(exported).toContain("idx_relay_users_email");
      expect(exported).not.toContain(email);
      expect(exported).not.toContain(second);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
