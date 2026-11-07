import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
  type OrchestratorMcpThreadSearchInput,
  type PeerLinkStatus,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadsLayer } from "./McpToolAccess.testkit.ts";
import * as ThreadSearchMcpService from "./ThreadSearchMcpService.ts";

const here = EnvironmentId.make("environment:here");
const box = EnvironmentId.make("environment:box");
const denied = EnvironmentId.make("environment:denied");
const offline = EnvironmentId.make("environment:offline");
const expired = EnvironmentId.make("environment:expired");
const sameId = ThreadId.make("thread:same-id");
const projectId = ProjectId.make("project:matching");
const hit = (title: string) => ({ threadId: sameId, projectId, title, source: "title" as const });
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: here,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "search-test",
  thread: undefined,
  client: { sessionId: "reader", label: "Reader", access: "read-only" },
  linkedEnvironments: true,
};
const link = (environmentId: EnvironmentId, label: string, status: PeerLinkStatus) => ({
  environmentId,
  label,
  status,
  access: "read-only" as const,
  expiresAt: "2027-01-01T00:00:00.000Z",
  lastError: null,
});
const layerSearch = ThreadSearchMcpService.layer.pipe(
  Layer.provide(
    Layer.mock(ThreadSearch.ThreadSearch)({
      searchThreads: (input) =>
        Effect.succeed({
          matches:
            input.projectId !== undefined && input.projectId !== projectId
              ? []
              : [hit("Local settled work"), hit("Another local result")],
        }),
    }),
  ),
);
const run = (input: OrchestratorMcpThreadSearchInput, invocation = scope) =>
  ThreadSearchMcpService.ThreadSearchMcpService.pipe(
    Effect.flatMap((service) => service.search(input)),
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provide(liveThreadsLayer),
  );

it.effect(
  "keeps readable results and machine identities when another peer is offline or refuses",
  () =>
    Effect.gen(function* () {
      const events: unknown[] = [];
      const analytics = AnalyticsService.AnalyticsService.of({
        recordOwners: () => Effect.void,
        record: (event, properties) =>
          Effect.sync(() => {
            events.push({ event, properties });
          }),
        flush: Effect.void,
      });
      const result = yield* run({ query: "work", limit: 2 }).pipe(
        Effect.provide(
          layerSearch.pipe(
            Layer.provide(Layer.succeed(AnalyticsService.AnalyticsService, analytics)),
            Layer.provide(
              Layer.mock(PeerForwarding.PeerForwarding)({
                links: () =>
                  Effect.succeed({
                    environmentId: here,
                    notListed: "",
                    links: [
                      link(box, "Box", "reachable"),
                      link(denied, "Private", "reachable"),
                      link(offline, "Offline", "unreachable"),
                      link(expired, "Expired", "expired"),
                    ],
                  }),
                searchThreads: (_scope, environmentId) =>
                  environmentId === box
                    ? Effect.succeed({ matches: [hit("Remote completed work")] })
                    : environmentId === denied
                      ? Effect.fail(
                          new OrchestratorMcpFailure({
                            code: "capability_denied",
                            message: "That machine accepts nothing from other machines.",
                          }),
                        )
                      : Effect.die("Offline and expired machines must not be searched."),
              }),
            ),
          ),
        ),
      );
      expect(result.matches.map(({ environmentId, title }) => [environmentId, title])).toEqual([
        [here, "Local settled work"],
        [box, "Remote completed work"],
      ]);
      expect(result.matches[1]).toMatchObject({ environmentLabel: "Box", threadId: sameId });
      expect(result.matches[0]?.link).toContain(here);
      expect(result.matches[1]?.link).toContain(box);
      expect(result.machines).toEqual([
        { environmentId: here, environmentLabel: here, status: "searched" },
        { environmentId: box, environmentLabel: "Box", status: "searched" },
        {
          environmentId: denied,
          environmentLabel: "Private",
          status: "skipped",
          reason: "That machine accepts nothing from other machines.",
        },
        {
          environmentId: offline,
          environmentLabel: "Offline",
          status: "offline",
          reason: "The machine did not answer.",
        },
        {
          environmentId: expired,
          environmentLabel: "Expired",
          status: "skipped",
          reason: "The link has expired.",
        },
      ]);
      expect(events).toEqual([
        {
          event: "feature.used",
          properties: {
            feature: "fleet-thread-search",
            action: "search",
            source: "agent",
            outcome: "success",
            durationMs: 0,
          },
        },
      ]);
    }),
);

it.effect("keeps explicit machine and local project searches scoped", () =>
  Effect.gen(function* () {
    const layer = layerSearch.pipe(
      Layer.provide(
        Layer.mock(PeerForwarding.PeerForwarding)({
          links: () =>
            Effect.succeed({
              environmentId: here,
              notListed: "",
              links: [link(box, "Box", "reachable")],
            }),
          searchThreads: (_scope, _environmentId, input) =>
            Effect.succeed({
              matches: input.projectId === projectId ? [hit("Remote project")] : [],
            }),
        }),
      ),
    );
    const remote = yield* run({ query: "work", environmentId: box, projectId }).pipe(
      Effect.provide(layer),
    );
    expect(remote.matches.map((match) => match.title)).toEqual(["Remote project"]);
    expect(remote.machines.map((machine) => machine.environmentId)).toEqual([box]);
    const local = yield* run({ query: "work", projectId: ProjectId.make("project:other") }).pipe(
      Effect.provide(layer),
    );
    expect(local.matches).toEqual([]);
    expect(local.machines.map((machine) => machine.environmentId)).toEqual([here]);
    const explicit = yield* run({ query: "work", environmentId: here }).pipe(Effect.provide(layer));
    expect(explicit.machines.map((machine) => machine.environmentId)).toEqual([here]);
    const outside = yield* run(
      { query: "work", environmentId: here },
      {
        ...scope,
        client: { ...scope.client!, webOrigin: "https://source.example" },
      },
    ).pipe(Effect.provide(layer));
    expect(outside.matches[0]?.link).toBe(
      `https://source.example/${encodeURIComponent(here)}/${encodeURIComponent(sameId)}`,
    );
  }),
);

it.effect("never fans a forwarded search out again and reports disabled link discovery", () =>
  Effect.gen(function* () {
    const layer = layerSearch.pipe(
      Layer.provide(
        Layer.mock(PeerForwarding.PeerForwarding)({
          links: () => Effect.die("Forwarded and disabled searches must stay local."),
        }),
      ),
    );
    const forwarded = yield* run(
      { query: "work" },
      { ...scope, client: { ...scope.client!, linked: true } },
    ).pipe(Effect.provide(layer));
    expect(forwarded.machines.map((machine) => machine.environmentId)).toEqual([here]);
    const disabled = yield* run({ query: "work" }, { ...scope, linkedEnvironments: false }).pipe(
      Effect.provide(layer),
    );
    expect(disabled.matches).toHaveLength(2);
    expect(disabled.notes.join(" ")).toContain("off");
  }),
);

it.effect("times out an unresponsive peer without dropping completed local results", () =>
  Effect.gen(function* () {
    const searching = yield* Deferred.make<void>();
    const layer = layerSearch.pipe(
      Layer.provide(
        Layer.mock(PeerForwarding.PeerForwarding)({
          links: () =>
            Effect.succeed({
              environmentId: here,
              notListed: "",
              links: [link(box, "Box", "reachable")],
            }),
          searchThreads: () =>
            Deferred.succeed(searching, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      ),
    );
    const fiber = yield* run({ query: "work" }).pipe(Effect.provide(layer), Effect.forkChild);
    yield* Deferred.await(searching);
    yield* TestClock.adjust("10 seconds");
    const result = yield* Fiber.join(fiber);
    expect(result.matches).toHaveLength(2);
    expect(result.machines[1]).toMatchObject({
      environmentId: box,
      status: "offline",
      reason: "The search timed out.",
    });
  }),
);
