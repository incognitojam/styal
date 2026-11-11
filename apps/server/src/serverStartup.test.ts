import { FetchHttpClient, HttpClient } from "effect/http";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import { rejectRequestsUntilServing } from "./httpResponseErrorGuard.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { makeStartupStatus, prepareBeforeRuntime } from "./serverStartup.ts";

it.effect("leases readiness only until byte progress expires", () =>
  Effect.gen(function* () {
    const status = yield* makeStartupStatus();
    const progress = { phase: "copying" as const, copiedBytes: 1, totalBytes: 100, leaseMs: 60000 };
    yield* status.report(progress);
    yield* TestClock.adjust("20 seconds");
    assert.equal(status.current()?.leaseMs, 40000);
    yield* status.report({ ...progress, copiedBytes: 2 });
    assert.equal(status.current()?.leaseMs, 60000);
    yield* TestClock.adjust("61 seconds");
    assert.equal(status.current()?.leaseMs, 0);
    yield* status.report(null);
    assert.isNull(status.current());
  }),
);

it.effect("listens before acquiring persistence with pruning disabled", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => rejectRequestsUntilServing(NodeHttp.createServer())),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
    );
    const listen = Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    });
    const persistence = Effect.gen(function* () {
      assert.isTrue(server.listening);
      const address = server.address();
      assert.isTrue(address !== null && typeof address !== "string");
      if (address !== null && typeof address !== "string") {
        const response = yield* HttpClient.get(`http://127.0.0.1:${address.port}`).pipe(
          Effect.provide(FetchHttpClient.layer),
        );
        assert.equal(response.status, 503);
      }
    });
    yield* prepareBeforeRuntime(false, listen, persistence);
    yield* listen;
    yield* persistence;
  }).pipe(Effect.scoped),
);
