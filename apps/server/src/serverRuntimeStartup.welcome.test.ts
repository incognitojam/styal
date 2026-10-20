import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as EventSink from "./orchestration-v2/EventSink.ts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as LegacyImporter from "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Recovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as Sessions from "./orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as EffectWorker from "./orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as Projects from "./project/ProjectService.ts";
import * as ProviderInstances from "./provider/ProviderInstanceRegistry.ts";
import * as Relay from "./relay/AgentAwarenessRelay.ts";
import * as Lifecycle from "./serverLifecycleEvents.ts";
import * as Startup from "./serverRuntimeStartup.ts";
import * as Settings from "./serverSettings.ts";
import * as Environment from "./environment/ServerEnvironment.ts";
import * as Launcher from "./cloud/serviceLauncherClient.ts";
import * as Analytics from "./telemetry/AnalyticsService.ts";
import * as FileSystem from "effect/FileSystem";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as Git from "./vcs/GitVcsDriver.ts";

it.effect.each(["success", "retry"] as const)(
  "prepares shutdown once, waits for concurrent callers, and keeps commands closed: %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        let captureCalls = 0;
        let providerShutdownCalls = 0;
        let reconciliationCalls = 0;
        const lifecycle = yield* Lifecycle.ServerLifecycleEvents;
        const bootstrapStarted = yield* Deferred.make<void>();
        const finishBootstrap = yield* Deferred.make<void>();
        const workerStarted = yield* Deferred.make<void>();
        const workerStopped = yield* Deferred.make<void>();
        const captureStarted = yield* Deferred.make<void>();
        const finishCapture = yield* Deferred.make<void>();
        const secondCompleted = yield* Deferred.make<void>();
        const projectId = ProjectId.make("synthetic-bootstrap-project");
        const threadId = ThreadId.make("synthetic-bootstrap-thread");
        const services = Layer.mergeAll(
          Layer.mock(HttpServer.HttpServer)({
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
          }),
          FileSystem.layerNoop({}),
          Layer.mock(ServerSecretStore.ServerSecretStore)({ get: () => Effect.succeedNone }),
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
          Layer.mock(ExternalLauncher.ExternalLauncher)({}),
          Layer.mock(EventSink.EventSinkV2)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({ recoverDelegatedTasks: Effect.void }),
          Layer.mock(ServerConfig.ServerConfig)({
            cwd: "/workspace/example",
            mode: "desktop",
            host: "127.0.0.1",
            port: 3773,
            noBrowser: true,
            autoBootstrapProjectFromCwd: true,
          } as never),
          Layer.mock(Keybindings.Keybindings)({ start: Effect.void }),
          Layer.mock(Settings.ServerSettingsService)({
            start: Effect.void,
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          }),
          Layer.mock(LegacyImporter.LegacyV1ThreadImporter)({
            pendingThreadCount: Effect.succeed(0),
            reconcileShells: Effect.succeed({ importedThreadCount: 0 } as never),
            importPendingTranscripts: Effect.succeed({ importedThreadCount: 0 } as never),
          }),
          Layer.mock(Recovery.ProviderRuntimeRecoveryService)({
            recover: Effect.succeed({} as never),
            prepareForShutdown: Effect.gen(function* () {
              captureCalls += 1;
              assert.isTrue(yield* Deferred.isDone(workerStopped));
              if (scenario === "retry" && captureCalls === 1) {
                return yield* new Recovery.ProviderRuntimeRecoveryError({
                  operation: "read-projections",
                  cause: "Synthetic recovery query failure",
                });
              }
              yield* Deferred.succeed(captureStarted, undefined);
              yield* Deferred.await(finishCapture);
            }),
            reconcile: (trigger) =>
              Effect.sync(() => {
                assert.equal(trigger, "shutdown");
                reconciliationCalls += 1;
                return {} as never;
              }),
          }),
          Layer.mock(Sessions.ProviderSessionManagerV2)({
            shutdown: Effect.sync(() => {
              providerShutdownCalls += 1;
            }),
          }),
          Layer.mock(Relay.AgentAwarenessRelay)({ start: () => Effect.void }),
          Layer.mock(ProviderInstances.ProviderInstanceRegistry)({
            getInstance: () => Effect.succeed(undefined),
          }),
          Layer.mock(Projects.ProjectService)({
            bootstrap: () =>
              Deferred.succeed(bootstrapStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishBootstrap)),
                Effect.as({ project: { id: projectId } } as never),
              ),
            snapshot: Effect.succeed({ projects: [] } as never),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getShellSnapshot: () =>
              Effect.succeed({
                threads: [{ id: threadId, projectId, lineage: { relationshipToParent: null } }],
                archivedThreads: [],
              } as never),
          }),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
          Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
          Layer.mock(Environment.ServerEnvironment)({
            getDescriptor: Effect.succeed({ environmentId: "synthetic-environment" } as never),
          }),
          Layer.mock(Launcher.ServiceLauncherClient)({
            managed: false,
            prepareTrial: Effect.succeed(undefined),
          }),
          Layer.mock(Analytics.AnalyticsService)({ record: () => Effect.void }),
          Layer.mock(Git.GitVcsDriver)({}),
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runOnce: Deferred.succeed(workerStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(workerStopped, undefined)),
            ),
          }),
          Layer.succeed(Lifecycle.ServerLifecycleEvents, lifecycle),
        );
        const serviceScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        );
        const context = yield* Layer.buildWithScope(
          Startup.layerWithOptions().pipe(
            Layer.provide(services),
            Layer.provide(NodeServices.layer),
          ),
          serviceScope,
        );
        yield* Effect.addFinalizer(() => Deferred.succeed(finishCapture, undefined));
        const startup = Context.get(context, Startup.ServerRuntimeStartup);
        yield* Deferred.await(bootstrapStarted);
        yield* startup.markHttpListening;
        assert.equal((yield* lifecycle.snapshot).events.length, 0);
        yield* Deferred.succeed(finishBootstrap, undefined);
        yield* startup.awaitCommandReady;
        const welcome = (yield* lifecycle.snapshot).events.find(
          (event) => event.type === "welcome",
        );
        assert.equal(welcome?.payload.bootstrapStatus, "complete");
        assert.equal(welcome?.payload.bootstrapProjectId, projectId);
        assert.equal(welcome?.payload.bootstrapThreadId, threadId);
        yield* Deferred.await(workerStarted);
        assert.equal(yield* startup.enqueueCommand(Effect.succeed("accepted")), "accepted");
        if (scenario === "retry") {
          const failed = yield* startup.prepareForShutdown.pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(failed));
          const rejected = yield* startup
            .enqueueCommand(Effect.succeed("too late"))
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(rejected));
        }
        const first = yield* startup.prepareForShutdown.pipe(Effect.forkChild);
        yield* Deferred.await(captureStarted);
        assert.isTrue(yield* Deferred.isDone(workerStopped));
        const second = yield* startup.prepareForShutdown.pipe(
          Effect.andThen(Deferred.succeed(secondCompleted, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
        assert.isFalse(yield* Deferred.isDone(secondCompleted));
        assert.equal(captureCalls, scenario === "retry" ? 2 : 1);
        const rejected = yield* startup
          .enqueueCommand(Effect.succeed("too late"))
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(rejected));
        yield* Deferred.succeed(finishCapture, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        yield* startup.prepareForShutdown;
        yield* Scope.close(serviceScope, Exit.void);
        assert.equal(captureCalls, scenario === "retry" ? 2 : 1);
        assert.equal(providerShutdownCalls, 1);
        assert.equal(reconciliationCalls, 1);
      }).pipe(Effect.provide(Layer.merge(Lifecycle.layer, NodeServices.layer))),
    ),
);

it.effect("starts the bootstrap thread on Codex when the environment turned Claude off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.ServerLifecycleEvents;
      const projectId = ProjectId.make("synthetic-bootstrap-project");
      const threadId = ThreadId.make("synthetic-bootstrap-thread");
      const launched: Array<ModelSelection> = [];
      const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        providerInstances: {
          [ProviderInstanceId.make("claudeAgent")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: false,
          },
        },
      });
      const services = Layer.mergeAll(
        Layer.mock(HttpServer.HttpServer)({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
        }),
        FileSystem.layerNoop({}),
        Layer.mock(ServerSecretStore.ServerSecretStore)({ get: () => Effect.succeedNone }),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
        Layer.mock(ExternalLauncher.ExternalLauncher)({}),
        Layer.mock(EventSink.EventSinkV2)({}),
        Layer.mock(Orchestrator.OrchestratorV2)({ recoverDelegatedTasks: Effect.void }),
        Layer.mock(ServerConfig.ServerConfig)({
          cwd: "/workspace/example",
          mode: "desktop",
          host: "127.0.0.1",
          port: 3773,
          noBrowser: true,
          autoBootstrapProjectFromCwd: true,
        } as never),
        Layer.mock(Keybindings.Keybindings)({ start: Effect.void }),
        Layer.mock(Settings.ServerSettingsService)({
          start: Effect.void,
          getSettings: Effect.succeed(settings),
        }),
        Layer.mock(LegacyImporter.LegacyV1ThreadImporter)({
          pendingThreadCount: Effect.succeed(0),
          reconcileShells: Effect.succeed({ importedThreadCount: 0 } as never),
          importPendingTranscripts: Effect.succeed({ importedThreadCount: 0 } as never),
        }),
        Layer.mock(Recovery.ProviderRuntimeRecoveryService)({
          recover: Effect.succeed({} as never),
          prepareForShutdown: Effect.void,
          reconcile: () => Effect.succeed({} as never),
        }),
        Layer.mock(Sessions.ProviderSessionManagerV2)({ shutdown: Effect.void }),
        Layer.mock(Relay.AgentAwarenessRelay)({ start: () => Effect.void }),
        Layer.mock(ProviderInstances.ProviderInstanceRegistry)({
          getInstance: () => Effect.succeed(undefined),
        }),
        Layer.mock(Projects.ProjectService)({
          bootstrap: () => Effect.succeed({ project: { id: projectId } } as never),
          snapshot: Effect.succeed({ projects: [] } as never),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] } as never),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              launched.push(input.modelSelection);
              return { threadId } as never;
            }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
        Layer.mock(Environment.ServerEnvironment)({
          getDescriptor: Effect.succeed({ environmentId: "synthetic-environment" } as never),
        }),
        Layer.mock(Launcher.ServiceLauncherClient)({
          managed: false,
          prepareTrial: Effect.succeed(undefined),
        }),
        Layer.mock(Analytics.AnalyticsService)({ record: () => Effect.void }),
        Layer.mock(Git.GitVcsDriver)({}),
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.never }),
        Layer.succeed(Lifecycle.ServerLifecycleEvents, lifecycle),
      );
      const context = yield* Layer.build(
        Startup.layerWithOptions().pipe(Layer.provide(services), Layer.provide(NodeServices.layer)),
      );
      const startup = Context.get(context, Startup.ServerRuntimeStartup);
      yield* startup.markHttpListening;
      yield* startup.awaitCommandReady;
      assert.deepEqual(
        launched.map((selection) => selection.instanceId),
        [ProviderInstanceId.make("codex")],
      );
      const welcome = (yield* lifecycle.snapshot).events.find((event) => event.type === "welcome");
      assert.equal(welcome?.payload.bootstrapThreadId, threadId);
    }).pipe(Effect.provide(Layer.merge(Lifecycle.layer, NodeServices.layer))),
  ),
);
