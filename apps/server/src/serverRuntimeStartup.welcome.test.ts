import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as ExternalLauncher from "./process/externalLauncher.ts";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as Keybindings from "./keybindings.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as OrchestrationReactor from "./orchestration/Services/OrchestrationReactor.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ProviderSessionReaper from "./provider/Services/ProviderSessionReaper.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

it.effect("publishes pending before complete even without an activation gate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const bootstrapLookupDone = yield* Deferred.make<void>();
      const completedWelcome = yield* Deferred.make<void>();
      const statuses: string[] = [];
      const startup = yield* ServerRuntimeStartup.make().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HttpServer.HttpServer, {} as never),
            Layer.succeed(ExternalLauncher.ExternalLauncher, {} as never),
            Layer.succeed(ServerConfig.ServerConfig, {
              cwd: "/workspace/example",
              mode: "desktop",
              port: 3773,
              noBrowser: true,
              autoBootstrapProjectFromCwd: true,
            } as never),
            Layer.succeed(Keybindings.Keybindings, { start: Effect.void } as never),
            Layer.succeed(ServerSettings.ServerSettingsService, { start: Effect.void } as never),
            Layer.succeed(OrchestrationReactor.OrchestrationReactor, {
              start: () => Effect.void,
            } as never),
            Layer.succeed(ProviderSessionReaper.ProviderSessionReaper, {
              start: () => Effect.void,
            } as never),
            Layer.succeed(ProviderService.ProviderService, {
              listSessions: () => Effect.succeed([]),
            } as never),
            Layer.succeed(ProviderSessionDirectory.ProviderSessionDirectory, {} as never),
            Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {} as never),
            Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
              getCommandReadModel: () => Effect.succeed({ threads: [] }),
              getShellSnapshot: () => Effect.succeed({ projects: [] }),
              getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 1 }),
              getActiveProjectByWorkspaceRoot: () =>
                Effect.succeed(
                  Option.some({
                    id: ProjectId.make("existing-project"),
                    defaultModelSelection: null,
                  }),
                ),
              getFirstActiveThreadIdByProjectId: () =>
                Deferred.succeed(bootstrapLookupDone, undefined).pipe(
                  Effect.as(Option.some(ThreadId.make("existing-thread"))),
                ),
            } as never),
            Layer.succeed(ServerEnvironment.ServerEnvironment, {
              getDescriptor: Effect.succeed({ environmentId: "test-environment" }),
            } as never),
            Layer.succeed(ServiceLauncherClient.ServiceLauncherClient, {
              prepareTrial: Effect.void,
            } as never),
            Layer.succeed(EnvironmentAuth.EnvironmentAuth, {} as never),
            Layer.succeed(GitVcsDriver.GitVcsDriver, {} as never),
            Layer.succeed(AnalyticsService.AnalyticsService, {
              record: () => Effect.void,
            } as never),
            Layer.succeed(ServerLifecycleEvents.ServerLifecycleEvents, {
              ...lifecycle,
              publish: (event) =>
                lifecycle.publish(event).pipe(
                  Effect.tap(() => {
                    if (event.type !== "welcome") return Effect.void;
                    statuses.push(event.payload.bootstrapStatus ?? "unknown");
                    return event.payload.bootstrapStatus === "complete"
                      ? Deferred.succeed(completedWelcome, undefined)
                      : Effect.void;
                  }),
                ),
            }),
          ),
        ),
      );

      // Bootstrap can finish while the HTTP listener is still preparing.
      yield* Deferred.await(bootstrapLookupDone);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(statuses, []);
      yield* startup.markHttpListening;
      yield* startup.awaitCommandReady;
      yield* Deferred.await(completedWelcome);
      assert.deepStrictEqual(statuses, ["pending", "complete"]);
      const snapshot = yield* lifecycle.snapshot;
      const welcome = snapshot.events.find((event) => event.type === "welcome");
      assert.equal(welcome?.payload.bootstrapStatus, "complete");
    }).pipe(Effect.provide(Layer.mergeAll(ServerLifecycleEvents.layer, NodeServices.layer))),
  ),
);
