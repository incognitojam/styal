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
const hostId = EnvironmentDeviceHost.environmentDeviceHostId(environmentId);
const profile = { deviceId: "simulator", type: "setMemoryProfile", mode: "standard" } as const;

it.effect.each([
  {
    name: "profile",
    command: { operation: "action", input: profile },
    seconds: 800,
    succeeds: true,
  },
  {
    name: "agent profile",
    command: { operation: "agent-action", input: profile, threadId: ThreadId.make("agent") },
    seconds: 800,
    succeeds: true,
  },
  {
    name: "helper download",
    command: {
      operation: "action",
      input: { deviceId: "simulator", type: "prepareSimulatorMemory" },
    },
    seconds: 90,
    succeeds: true,
  },
  {
    name: "ordinary settings",
    command: {
      operation: "action",
      input: { deviceId: "simulator", type: "setAppearance", value: "dark" },
    },
    seconds: 61,
    succeeds: false,
  },
] satisfies ReadonlyArray<{
  name: string;
  command: DevicePeerCommand;
  seconds: number;
  succeeds: boolean;
}>)("$name has an appropriate connected-host deadline", ({ command, seconds, succeeds }) =>
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
        yield* Effect.sleep(`${seconds} seconds`);
        return HttpClientResponse.fromWeb(request, Response.json(null));
      }),
    );
    const client = yield* EnvironmentDeviceHost.makeClient(
      {
        id: hostId,
        label: "Simulator host",
        environmentId,
        url: "http://simulator.test",
        sessionId: AuthSessionId.make("synthetic"),
      },
      "synthetic",
      "client",
    ).pipe(Effect.provideService(HttpClient.HttpClient, http));
    const request = yield* client
      .request(command, Schema.Null)
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust(`${seconds} seconds`);
    expect((yield* Fiber.join(request))._tag).toBe(succeeds ? "Success" : "Failure");
  }).pipe(Effect.scoped),
);
