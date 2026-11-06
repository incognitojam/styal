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
  ...overrides,
});
const origin = { linkOrigin: { sessionId: "session", label: "styal · sol" } };
const shells = [
  shell("from-machine", origin),
  shell("failing-to-stop", origin),
  shell("from-machine-too", origin),
  shell("yours", {}),
  shell("idle", { ...origin, activeRunId: null }),
  shell("archived", { ...origin, archivedAt: "2026-11-06T00:00:00.000Z" }),
];

const fixture = () => {
  const interrupted: Array<string> = [];
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
        interruptThread: (input) =>
          input.threadId === ThreadId.make("failing-to-stop")
            ? Effect.die("provider gone")
            : Effect.sync(() => {
                interrupted.push(input.threadId);
                return { type: "no_active_run" } as const;
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
  );
  return { interrupted, devicesClosed, layer };
};

it.effect("counts running threads other machines started, and only those", () => {
  const { layer } = fixture();
  return Effect.gen(function* () {
    const access = yield* IncomingMachineAccess.IncomingMachineAccess;
    expect(yield* access.work).toEqual({ runningThreads: 3 });
  }).pipe(Effect.provide(layer));
});

it.effect.each(["view-only", "nothing"] as const)(
  "stops that work and closes shared devices when set to %s, past a thread that fails",
  (level) => {
    const { interrupted, devicesClosed, layer } = fixture();
    return Effect.gen(function* () {
      const access = yield* IncomingMachineAccess.IncomingMachineAccess;
      yield* access.settingChanged(level);
      expect(interrupted).toEqual(["from-machine", "from-machine-too"]);
      expect(devicesClosed.count).toBe(1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("stops nothing when set to everything", () => {
  const { interrupted, devicesClosed, layer } = fixture();
  return Effect.gen(function* () {
    const access = yield* IncomingMachineAccess.IncomingMachineAccess;
    yield* access.settingChanged("everything");
    expect(interrupted).toEqual([]);
    expect(devicesClosed.count).toBe(0);
  }).pipe(Effect.provide(layer));
});
