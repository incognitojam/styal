import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import { getTelemetryIdentifier } from "./Identify.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

interface RecordedBatchRequest {
  readonly path: string;
  readonly body: {
    readonly api_key?: string;
    readonly batch?: ReadonlyArray<{
      readonly event?: string;
      readonly timestamp?: string;
      readonly properties?: {
        readonly index?: number;
        readonly clientType?: string;
        readonly serverOs?: string;
        readonly serverArch?: string;
        readonly serverAppVersion?: string;
        readonly serverMode?: string;
        readonly t3CodeVersion?: string;
        readonly t3CodeRepository?: string;
        readonly featureUsageVersion?: number;
        readonly deviceUsageVersion?: number;
        readonly workflowRunWatchUsageVersion?: number;
        readonly providerAnalyticsUsageVersion?: number;
        readonly settingsSnapshotUsageVersion?: number;
        readonly buildKind?: string;
        readonly releaseChannel?: string;
      };
    }>;
  } | null;
}

interface RecordedBatchBody {
  readonly api_key?: string;
  readonly batch: ReadonlyArray<{
    readonly event?: string;
    readonly properties?: {
      readonly index?: number;
      readonly clientType?: string;
      readonly serverOs?: string;
      readonly serverArch?: string;
      readonly serverAppVersion?: string;
      readonly serverMode?: string;
      readonly t3CodeVersion?: string;
      readonly t3CodeRepository?: string;
      readonly featureUsageVersion?: number;
      readonly deviceUsageVersion?: number;
      readonly workflowRunWatchUsageVersion?: number;
      readonly providerAnalyticsUsageVersion?: number;
      readonly settingsSnapshotUsageVersion?: number;
      readonly buildKind?: string;
      readonly releaseChannel?: string;
    };
  }>;
}

/** Accepts PostHog batch POSTs and records each parsed body for assertions. */
const batchCaptureServer = (capturedRequests: Array<RecordedBatchRequest>) =>
  HttpServer.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.method !== "POST") {
        return HttpServerResponse.empty({ status: 404 });
      }

      const payload = yield* request.json.pipe(
        Effect.map((body) => body as RecordedBatchRequest["body"]),
        Effect.orElseSucceed(() => null),
      );

      capturedRequests.push({ path: request.url, body: payload });

      return HttpServerResponse.jsonUnsafe({});
    }),
  );

const SentBatch = Schema.fromJsonString(
  Schema.Struct({
    batch: Schema.Array(Schema.Struct({ uuid: Schema.String })),
  }),
);

/**
 * HTTP client that reads each batch, then fails as if the connection dropped
 * before the response arrived. PostHog stores these batches, so the server
 * must not send them forever.
 */
const layerAcceptThenFailClient = (batches: Array<ReadonlyArray<{ readonly uuid: string }>>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.body._tag === "Uint8Array") {
          const body = yield* Schema.decodeEffect(SentBatch)(
            new TextDecoder().decode(request.body.body),
          ).pipe(Effect.orDie);
          batches.push(body.batch);
        }
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: "connection reset" }),
        });
      }),
    ),
  );

it("retryDelayMs doubles from 2s and stays under the 5 minute cap", () => {
  assert.equal(AnalyticsService.retryDelayMs(1, 0), 1_000);
  assert.equal(AnalyticsService.retryDelayMs(2, 0.999_999), 4_000);
  assert.equal(AnalyticsService.retryDelayMs(30, 0), 150_000);
  assert.equal(AnalyticsService.retryDelayMs(30, 0.999_999), 300_000);
});

it.layer(NodeServices.layer)("AnalyticsService test", (it) => {
  it.effect("a batch that keeps failing is retried with backoff, then dropped", () =>
    Effect.gen(function* () {
      const batches: Array<ReadonlyArray<{ readonly uuid: string }>> = [];
      const layerRuntime = AnalyticsService.layer.pipe(
        Layer.provideMerge(
          ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-telemetry-retry-" }),
        ),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              T3CODE_TELEMETRY_ENABLED: true,
              T3CODE_POSTHOG_KEY: "phc_test_key",
              T3CODE_POSTHOG_HOST: "http://localhost",
            }),
          ),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "win32"),
            Layer.succeed(HostProcess.Architecture, "x64"),
            layerAcceptThenFailClient(batches),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        for (let index = 0; index < 20; index += 1) {
          yield* analytics.record("test.retry", { index });
        }
        // Before the fix this loop sent the batch about once a second.
        for (let second = 0; second < 600; second += 1) {
          yield* TestClock.adjust("1 second");
        }
      }).pipe(Effect.provide(layerRuntime));

      assert.equal(batches.length, 5);
      const uuids = batches.map((batch) => batch.map((event) => event.uuid).join(","));
      assert.equal(new Set(uuids).size, 1, "every retry carries the same uuids");
      assert.equal(new Set(batches[0]?.map((event) => event.uuid)).size, 20);
    }),
  );

  it.effect("flush drains all buffered events across multiple batches", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const layerServerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-base-",
      });

      const layerTelemetry = AnalyticsService.layer.pipe(Layer.provideMerge(layerServerConfig));
      const layerConfig = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: true,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "http://localhost",
          T3CODE_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        }),
      );
      const layerBatchServer = batchCaptureServer(capturedRequests);
      const layerRuntime = layerTelemetry.pipe(
        Layer.provide(layerConfig),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "linux"),
            Layer.succeed(HostProcess.Architecture, "arm64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(layerBatchServer).pipe(Effect.forkScoped);
        const telemetryIdentifier = yield* getTelemetryIdentifier;
        assert.equal(telemetryIdentifier !== null, true);
        const analytics = yield* AnalyticsService.AnalyticsService;

        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.flush.drain", { index });
        }

        yield* analytics.flush;
      }).pipe(Effect.provide(layerRuntime));

      const batchRequests = capturedRequests.filter(
        (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.batch),
      );
      assert.equal(batchRequests.length, 3);
      assert.equal(
        batchRequests.every(
          (request) => request.path.endsWith("/batch/") || request.path.endsWith("/batch"),
        ),
        true,
      );
      const deliveredIndexes = batchRequests.flatMap((request) =>
        request.body.batch
          .filter((event) => event.event === "test.flush.drain")
          .map((event) => event.properties?.index)
          .filter((index): index is number => typeof index === "number"),
      );

      const sorted = deliveredIndexes.toSorted((a, b) => a - b);
      assert.equal(sorted.length, 45);
      assert.deepEqual(
        sorted,
        Array.from({ length: 45 }, (_, index) => index),
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every((event) => event.properties?.clientType === "cli-web-client"),
        ),
        true,
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every(
            (event) =>
              event.properties?.serverOs === "Linux" &&
              event.properties.serverArch === "arm64" &&
              event.properties.serverAppVersion === event.properties.t3CodeVersion &&
              event.properties.serverMode === "web" &&
              event.properties.t3CodeRepository === "incognitojam/styal" &&
              event.properties.featureUsageVersion === 1 &&
              event.properties.deviceUsageVersion === 1 &&
              event.properties.workflowRunWatchUsageVersion === 1 &&
              event.properties.providerAnalyticsUsageVersion === 1 &&
              event.properties.settingsSnapshotUsageVersion === 1 &&
              event.properties.buildKind === "test" &&
              event.properties.releaseChannel === "unknown",
          ),
        ),
        true,
      );
    }),
  );

  it.effect("sends a backdated event with the time it describes", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const runtimeLayer = AnalyticsService.layer.pipe(
        Layer.provideMerge(
          ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-telemetry-backdate-" }),
        ),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              T3CODE_TELEMETRY_ENABLED: true,
              T3CODE_POSTHOG_KEY: "phc_test_key",
              T3CODE_POSTHOG_HOST: "http://localhost",
            }),
          ),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "linux"),
            Layer.succeed(HostProcess.Architecture, "x64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchCaptureServer(capturedRequests)).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record(
          "test.backdated",
          {},
          { capturedAt: DateTime.makeUnsafe("2026-10-16T08:00:00.000Z") },
        );
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      const events = capturedRequests.flatMap((request) => request.body?.batch ?? []);
      assert.deepEqual(
        events.map((event) => [event.event, event.timestamp]),
        [["test.backdated", "2026-10-16T08:00:00.000Z"]],
      );
    }),
  );

  it.effect("delivers to the styal PostHog project when only the host is overridden", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const layerServerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-defaults-",
      });
      const layerTelemetry = AnalyticsService.layer.pipe(Layer.provideMerge(layerServerConfig));
      const layerConfig = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_POSTHOG_HOST: "http://localhost",
          T3CODE_TELEMETRY_ENABLED: true,
        }),
      );
      const layerRuntime = layerTelemetry.pipe(
        Layer.provide(layerConfig),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "linux"),
            Layer.succeed(HostProcess.Architecture, "arm64"),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchCaptureServer(capturedRequests)).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.defaults.delivered");
        yield* analytics.flush;
      }).pipe(Effect.provide(layerRuntime));

      const batchRequests = capturedRequests.filter(
        (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.batch),
      );
      assert.equal(batchRequests.length, 1);
      assert.equal(
        batchRequests[0]?.body.api_key,
        "phc_JxxoS00Uo92aC59Jnuw4e0ckYpg8UOk9ZiQ6TCedKWC",
      );
      assert.deepEqual(
        batchRequests[0]?.body.batch.map((event) => event.event),
        ["test.defaults.delivered"],
      );
    }),
  );

  it.effect.each([false, undefined])(
    "does not send batches when disabled or in an unopted-in test process (%s)",
    (enabled) =>
      Effect.gen(function* () {
        const capturedPaths: Array<string> = [];
        const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-telemetry-disabled-",
        });
        const telemetryLayer = AnalyticsService.layer.pipe(Layer.provideMerge(serverConfigLayer));
        const configLayer = ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ...(enabled === undefined ? {} : { T3CODE_TELEMETRY_ENABLED: enabled }),
            T3CODE_POSTHOG_KEY: "phc_test_key",
            T3CODE_POSTHOG_HOST: "http://localhost",
          }),
        );
        const batchServerLayer = HttpServer.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            capturedPaths.push(request.url);
            return HttpServerResponse.jsonUnsafe({});
          }),
        );
        const runtimeLayer = telemetryLayer.pipe(
          Layer.provide(configLayer),
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(HostProcess.Platform, "linux"),
              Layer.succeed(HostProcess.Architecture, "arm64"),
            ),
          ),
          Layer.provideMerge(NodeHttpServer.layerTest),
        );

        yield* Effect.gen(function* () {
          yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
          const analytics = yield* AnalyticsService.AnalyticsService;
          yield* analytics.record("test.disabled", { index: 1 });
          yield* analytics.flush;
        }).pipe(Effect.provide(runtimeLayer));

        assert.deepEqual(capturedPaths, []);
      }),
  );
});
