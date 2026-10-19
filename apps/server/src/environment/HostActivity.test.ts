import {
  EnvironmentId,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShellSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";
import { DeviceSharing } from "../device/DeviceSharing.ts";
import {
  ProjectionStoreV2,
  type ProjectionRuntimeRecoveryState,
} from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import * as ProviderInstallGate from "../provider/ProviderInstallGate.ts";
import * as ProviderInstallLock from "../provider/ProviderInstallLock.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { ServerEnvironmentIdentity } from "./ServerEnvironment.ts";
import { inspectHostActivity, summarizeHostSessions, withProjects } from "./HostActivity.ts";

const thread = (id: string) => ({
  id: ThreadId.make(id),
  title: `Thread ${id}`,
  projectId: ProjectId.make("project"),
  status: "idle" as const,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
});
describe("host session activity", () => {
  it("does not count open idle sessions as running work", () => {
    expect(summarizeHostSessions([thread("idle")])).toEqual({
      activeSessions: 0,
      continuableSessions: 0,
      waitingSessions: 0,
      affected: [],
    });
  });
  it("deduplicates a running provider thread and its background work", () => {
    const active = {
      ...thread("active"),
      status: "running" as const,
      pendingBackgroundTasks: [{ taskId: "task", kind: "monitor" as const }],
    };
    expect(summarizeHostSessions([active])).toEqual({
      activeSessions: 1,
      continuableSessions: 0,
      waitingSessions: 0,
      affected: [
        {
          projectId: "project",
          thread: {
            threadId: active.id,
            title: active.title,
            reasons: ["running", "monitor"],
            continuable: false,
          },
        },
      ],
    });
  });
  it("counts input waits separately and protects monitoring", () => {
    expect(
      summarizeHostSessions([
        { ...thread("approval"), status: "waiting" },
        { ...thread("input"), status: "waiting" },
        { ...thread("monitor"), pendingBackgroundTasks: [{ taskId: "monitor", kind: "monitor" }] },
      ]),
    ).toMatchObject({ activeSessions: 1, continuableSessions: 0, waitingSessions: 2 });
  });
  it("protects dispatched turns while preparing or starting", () => {
    expect(
      summarizeHostSessions([
        { ...thread("preparing"), status: "preparing" },
        { ...thread("starting"), status: "starting" },
      ]),
    ).toMatchObject({ activeSessions: 2, continuableSessions: 0, waitingSessions: 0 });
  });
  it("counts continuable threads only among active threads", () => {
    expect(
      summarizeHostSessions(
        [
          { ...thread("active"), status: "running" },
          { ...thread("wait"), status: "waiting" },
        ],
        new Set(["active", "wait", "idle"]),
      ),
    ).toMatchObject({ activeSessions: 1, continuableSessions: 1, waitingSessions: 1 });
  });
});

const pendingRequest = (kind: "user_input" | "permission") => ({
  id: RuntimeRequestId.make("request"),
  kind,
  createdAt: DateTime.makeUnsafe("2026-10-15T12:00:00.000Z"),
});

it.effect(
  "skips idle and waiting recovery reads even with continuation enabled, retaining background work",
  () => {
    const threads: Parameters<typeof summarizeHostSessions>[0] = [
      ...Array.from({ length: 100 }, (_, index) => thread(`idle-${index}`)),
      { ...thread("preparing"), status: "preparing" },
      { ...thread("starting"), status: "starting" },
      { ...thread("running"), status: "running" },
      {
        ...thread("monitor"),
        status: "completed",
        pendingBackgroundTasks: [{ taskId: "monitor", kind: "monitor" }],
      },
      { ...thread("waiting"), status: "waiting" },
      {
        ...thread("input"),
        status: "running",
        pendingRuntimeRequest: pendingRequest("user_input"),
      },
    ];
    const reads: ThreadId[] = [];
    return Effect.gen(function* () {
      const activity = yield* inspectHostActivity;
      expect(reads).toEqual(["preparing", "starting", "running", "monitor"]);
      expect(activity).toMatchObject({
        activeSessions: 4,
        waitingSessions: 2,
        continuableSessions: 0,
      });
      expect(activity.threads?.map((thread) => thread.threadId)).toEqual([
        "preparing",
        "starting",
        "running",
        "monitor",
        "waiting",
        "input",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ServerEnvironmentIdentity)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("lab")),
          }),
          Layer.mock(TerminalManager)({
            shutdownPreflight: Effect.succeed({
              terminalsRequiringConfirmation: 0,
              terminalsWithUnknownActivity: 0,
            }),
          }),
          Layer.mock(DeviceSharing)({ environmentsUsingDevices: Effect.succeed(0) }),
          Layer.mock(ProviderInstallGate.ProviderInstallGate)({
            installsInFlight: Effect.succeed(0),
          }),
          Layer.mock(ProjectStoreV2)({ list: () => Effect.succeed([]) }),
          Layer.mock(ProjectionStoreV2)({
            getShellSnapshot: () =>
              Effect.succeed({ threads } as unknown as OrchestrationV2ThreadShellSnapshot),
            getRecoveryThreadIds: () => Effect.succeed(threads.map((thread) => thread.id)),
            getRuntimeRecoveryProjection: (id) =>
              Effect.sync(() => {
                reads.push(id);
                return {
                  thread: {
                    id,
                    projectId: ProjectId.make("project"),
                    archivedAt: null,
                    deletedAt: null,
                  },
                  runs: [],
                  providerThreads: [],
                  providerSessions: [],
                  providerTurns: [],
                  turnItems: [],
                } as unknown as ProjectionRuntimeRecoveryState;
              }),
          }),
        ),
      ),
    );
  },
);

it.effect("counts a provider install in flight as work a restart would stop", () =>
  Effect.gen(function* () {
    const gate = yield* ProviderInstallGate.ProviderInstallGate;
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const install = yield* gate
      .tryInstall({ lockKey: "npm-global:/usr/local", packageName: "@openai/codex" }, () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    expect(yield* inspectHostActivity).toMatchObject({ activeSessions: 0, providerInstalls: 1 });

    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(install);
    expect(yield* inspectHostActivity).toMatchObject({ providerInstalls: 0 });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.effect(ProviderInstallGate.ProviderInstallGate, ProviderInstallGate.make).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProviderInstallLock.ProviderInstallLock)({
                tryRun: (_lockKey, run) => run(() => Effect.void).pipe(Effect.asSome),
              }),
              Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
            ),
          ),
        ),
        ServerSettings.layerTest(),
        Layer.mock(ServerEnvironmentIdentity)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("lab")),
        }),
        Layer.mock(TerminalManager)({
          shutdownPreflight: Effect.succeed({
            terminalsRequiringConfirmation: 0,
            terminalsWithUnknownActivity: 0,
          }),
        }),
        Layer.mock(DeviceSharing)({ environmentsUsingDevices: Effect.succeed(0) }),
        Layer.mock(ProjectStoreV2)({ list: () => Effect.succeed([]) }),
        Layer.mock(ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({ threads: [] } as unknown as OrchestrationV2ThreadShellSnapshot),
        }),
      ),
    ),
  ),
);

const sampleProject = {
  projectId: ProjectId.make("project"),
  title: "Sample project",
  workspaceRoot: "/workspace/sample",
  faviconPath: "brand/icon.svg",
  projectIcon: { kind: "emoji" as const, emoji: "🌿" },
};

describe("host thread details", () => {
  it("names each affected thread and explains all its work from the count's snapshot", () => {
    const activity = summarizeHostSessions(
      [
        thread("idle"),
        { ...thread("preparing"), status: "preparing" },
        { ...thread("starting"), status: "starting" },
        { ...thread("running"), status: "running" },
        {
          ...thread("input"),
          status: "running",
          pendingRuntimeRequest: pendingRequest("user_input"),
        },
        {
          ...thread("approval"),
          status: "waiting",
          pendingRuntimeRequest: pendingRequest("permission"),
        },
        { ...thread("waiting"), status: "waiting" },
        {
          ...thread("background"),
          status: "completed",
          pendingBackgroundTasks: [
            { taskId: "monitor-1", kind: "monitor" },
            { taskId: "monitor-2", kind: "monitor" },
            { taskId: "command", kind: "command" },
            { taskId: "subagent", kind: "subagent" },
            { taskId: "task", kind: "background_task" },
          ],
        },
      ],
      new Set(["running", "input", "background"]),
    );
    expect(activity).toMatchObject({
      activeSessions: 4,
      waitingSessions: 3,
      continuableSessions: 2,
    });
    expect(withProjects(activity.affected, [sampleProject])).toEqual(
      [
        {
          threadId: "preparing",
          title: "Thread preparing",
          reasons: ["preparing"],
          continuable: false,
        },
        {
          threadId: "starting",
          title: "Thread starting",
          reasons: ["starting"],
          continuable: false,
        },
        {
          threadId: "running",
          title: "Thread running",
          reasons: ["running"],
          continuable: true,
        },
        {
          threadId: "input",
          title: "Thread input",
          reasons: ["input"],
          continuable: false,
        },
        {
          threadId: "approval",
          title: "Thread approval",
          reasons: ["approval"],
          continuable: false,
        },
        {
          threadId: "waiting",
          title: "Thread waiting",
          reasons: ["waiting"],
          continuable: false,
        },
        {
          threadId: "background",
          title: "Thread background",
          reasons: ["monitor", "command", "subagent", "background_task"],
          continuable: true,
        },
      ].map((thread) => ({
        ...thread,
        project: {
          id: sampleProject.projectId,
          title: sampleProject.title,
          workspaceRoot: sampleProject.workspaceRoot,
          faviconPath: sampleProject.faviconPath,
          projectIcon: sampleProject.projectIcon,
        },
      })),
    );
  });

  it("leaves project identity off threads whose project is gone", () => {
    const { affected } = summarizeHostSessions([{ ...thread("running"), status: "running" }]);
    expect(withProjects(affected, [])).toEqual([
      { threadId: "running", title: "Thread running", reasons: ["running"], continuable: false },
    ]);
  });
});
