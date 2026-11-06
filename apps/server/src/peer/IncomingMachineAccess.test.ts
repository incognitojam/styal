import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DeviceSharing from "../device/DeviceSharing.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as IncomingMachineAccess from "./IncomingMachineAccess.ts";

const shell = (id: string, overrides: Record<string, unknown>) => ({
  id: ThreadId.make(id),
  projectId: ProjectId.make("project"),
  deletedAt: null,
  archivedAt: null,
  activeRunId: "run",
  pendingBackgroundTasks: [],
  ...overrides,
});
const origin = { linkOrigin: { sessionId: "session", label: "styal · sol" } };
const shells = [
  shell("from-machine", origin),
  shell("failing-to-stop", origin),
  shell("from-machine-too", origin),
  shell("yours", {}),
  shell("idle", { ...origin, activeRunId: null }),
  shell("watching-pr", {
    ...origin,
    activeRunId: null,
    pullRequests: [{ number: 1, watch: { startedAt: "2026-11-06T00:00:00.000Z" } }],
  }),
  shell("watching-workflow", { ...origin, activeRunId: null, workflowRuns: [{ runId: 1 }] }),
  shell("background", { ...origin, activeRunId: null, pendingBackgroundTasks: [{ id: "task" }] }),
  shell("archived", { ...origin, archivedAt: "2026-11-06T00:00:00.000Z" }),
];

const fixture = () => {
  const stopped: Array<string> = [];
  const devicesClosed = { count: 0 };
  const layer = IncomingMachineAccess.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        listActiveShellIndex: () =>
          Effect.succeed(
            [...shells, shell("not-live", origin)].map((entry) => ({
              id: entry.id,
              mayBeLive: entry.id !== ThreadId.make("not-live"),
            })) as never,
          ),
        getThreadShell: (id) =>
          Effect.succeed((shells.find((entry) => entry.id === id) ?? null) as never),
        dispatch: (command) =>
          command.type === "thread.stop" && command.threadId === ThreadId.make("failing-to-stop")
            ? Effect.die("provider gone")
            : Effect.sync(() => {
                if (command.type === "thread.stop") stopped.push(command.threadId);
                return { sequence: 0 } as never;
              }),
      }),
    ),
    Layer.provide(
      Layer.mock(DeviceSharing.DeviceSharing)({
        closePeerSessions: Effect.sync(() => {
          devicesClosed.count += 1;
        }),
      }),
    ),
    Layer.provide(NodeCrypto.layer),
  );
  return { stopped, devicesClosed, layer };
};

it.effect(
  "counts threads other machines started that have work left to stop, and only those",
  () => {
    const { layer } = fixture();
    return Effect.gen(function* () {
      const access = yield* IncomingMachineAccess.IncomingMachineAccess;
      expect(yield* access.work).toEqual({ threads: 6 });
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(["view-only", "nothing"] as const)(
  "stops that work and closes shared devices when set to %s, past a thread that fails",
  (level) => {
    const { stopped, devicesClosed, layer } = fixture();
    return Effect.gen(function* () {
      const access = yield* IncomingMachineAccess.IncomingMachineAccess;
      yield* access.settingChanged(level);
      expect(stopped).toEqual([
        "from-machine",
        "from-machine-too",
        "watching-pr",
        "watching-workflow",
        "background",
      ]);
      expect(devicesClosed.count).toBe(1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("stops nothing when set to everything", () => {
  const { stopped, devicesClosed, layer } = fixture();
  return Effect.gen(function* () {
    const access = yield* IncomingMachineAccess.IncomingMachineAccess;
    yield* access.settingChanged("everything");
    expect(stopped).toEqual([]);
    expect(devicesClosed.count).toBe(0);
  }).pipe(Effect.provide(layer));
});
