import { expect, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId, ThreadId, type DevicePeerCommand } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as EnvironmentDeviceHost from "./EnvironmentDeviceHost.ts";

const environmentId = EnvironmentId.make("simulator-host");
it.effect.each(["open", "open-low-memory"] as const)(
  "allows %s to finish preparation and boot after nine minutes",
  (operation) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          const body =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
          if (body.includes('"operation":"inspect"'))
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                environmentId,
                sourceEnvironmentId: "client",
                host: {
                  id: "local",
                  kind: "local",
                  label: "Simulator host",
                  platforms: [],
                  hubInstalled: true,
                  agentDeviceInstalled: false,
                },
                devices: [],
                sessions: [],
              }),
            );
          yield* Deferred.succeed(started, undefined);
          yield* Effect.sleep("540 seconds");
          return HttpClientResponse.fromWeb(request, Response.json(null));
        }),
      );
      const client = yield* EnvironmentDeviceHost.makeClient(
        {
          id: EnvironmentDeviceHost.environmentDeviceHostId(environmentId),
          label: "Simulator host",
          environmentId,
          url: "http://simulator.test",
          sessionId: AuthSessionId.make("synthetic"),
        },
        "synthetic",
        "client",
      ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      const command: DevicePeerCommand = {
        operation,
        input: { deviceId: "simulator", threadId: ThreadId.make("project"), platform: "ios" },
      };
      const request = yield* client.request(command, Schema.Null).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("540 seconds");
      expect(yield* Fiber.join(request)).toBeNull();
    }).pipe(Effect.scoped),
);
