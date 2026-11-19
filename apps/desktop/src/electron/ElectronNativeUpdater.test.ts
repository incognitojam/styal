import { describe, it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";

const { execFile, remove, nativeUpdater } = vi.hoisted(() => ({
  execFile: vi.fn(),
  remove: vi.fn(),
  nativeUpdater: { once: vi.fn(), removeListener: vi.fn(), checkForUpdates: vi.fn() },
}));
vi.mock("node:child_process", () => ({ execFile }));
vi.mock("node:util", () => ({ promisify: (fn: unknown) => fn }));
vi.mock("node:fs", () => ({ realpathSync: (path: string) => path, promises: { rm: remove } }));
vi.mock("node:os", () => ({ userInfo: () => ({ uid: 501 }) }));
vi.mock("electron", () => ({
  app: { getPath: () => "/Applications/Synthetic.app/Contents/MacOS/Synthetic" },
  autoUpdater: nativeUpdater,
}));

import { make } from "./ElectronNativeUpdater.ts";

const label = "build.synthetic.desktop.ShipIt";
const userTarget = `gui/501/${label}`;
const systemTarget = `system/${label}`;

function setup(
  options: {
    user?: string;
    system?: string;
    denied?: string;
    removalDenied?: boolean;
    disappearing?: boolean;
  } = {},
) {
  remove.mockClear();
  const jobs = new Map<string, string>();
  if (options.user !== undefined) jobs.set(userTarget, options.user);
  if (options.system !== undefined) jobs.set(systemTarget, options.system);
  const removed: string[] = [];
  execFile.mockReset();
  execFile.mockImplementation(async (command: string, args: string[]) => {
    if (command === "plutil") return { stdout: "build.synthetic.desktop\n" };
    const [operation, target] = args;
    if (operation === "print") {
      if (target === options.denied) throw { code: 1, stderr: "Operation not permitted" };
      if (!jobs.has(target!))
        throw {
          code: 3,
          stderr: `Bad request.\nCould not find service "${label}" in domain gui: 501\n`,
        };
      return { stdout: jobs.get(target!) };
    }
    expect(operation).toBe("bootout");
    if (options.disappearing) {
      jobs.delete(target!);
      throw { code: 3, stderr: "Boot-out failed: 3: No such process" };
    }
    if (options.removalDenied) throw { code: 1, stderr: "Operation not permitted" };
    removed.push(target!);
    jobs.delete(target!);
    return { stdout: "" };
  });
  return { jobs, removed };
}

describe("native ShipIt cleanup", () => {
  it.effect.each([
    "state = waiting",
    "state = exited\nlast exit code = 1",
    "state = not running\nlast exit code = 0",
  ])("unloads an inactive user job without deleting recovery files: %s", (user) =>
    Effect.gen(function* () {
      const state = setup({ user });
      yield* make.discard();
      expect(state.removed).toEqual(user.includes("last exit code = 0") ? [] : [userTarget]);
      expect(remove).not.toHaveBeenCalled();
    }),
  );

  it.effect("removes a stopped system job only when launchctl permits it", () =>
    Effect.gen(function* () {
      const state = setup({ system: "state = waiting\nlast exit code = 1" });
      yield* make.discard();
      expect(state.removed).toEqual([systemTarget]);
    }),
  );

  it.effect.each([userTarget, systemTarget])(
    "preserves running or waiting-with-PID installers and their recovery: %s",
    (target) =>
      Effect.gen(function* () {
        const state = setup({
          [target === userTarget ? "user" : "system"]: "state = running\npid = 42",
        });
        const error = yield* make.discard().pipe(Effect.flip);
        expect(error.message).toContain("running or waiting for styal to quit");
        expect(state.removed).toEqual([]);
        expect(remove).not.toHaveBeenCalled();
      }),
  );

  it.effect("allows cleanup of a job this process staged and kept waiting", () =>
    Effect.gen(function* () {
      const state = setup({ user: "state = running\npid = 42" });
      yield* make.discard({ ownStaged: true });
      expect(state.removed).toEqual([userTarget]);
      expect(remove).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    "does not confuse inspection permission failure with absence, and retries after repair",
    () =>
      Effect.gen(function* () {
        setup({ denied: systemTarget });
        const error = yield* make.discard().pipe(Effect.flip);
        expect(error.message).toContain(`launchctl print ${systemTarget} failed`);
        setup();
        yield* make.discard();
      }),
  );

  it.effect("reports denied system removal without touching its request, and can retry", () =>
    Effect.gen(function* () {
      const state = setup({ system: "state = waiting", removalDenied: true });
      const error = yield* make.discard().pipe(Effect.flip);
      expect(error.message).toContain("administrator");
      expect(state.jobs.has(systemTarget)).toBe(true);
      expect(remove).not.toHaveBeenCalled();
      setup();
      yield* make.discard();
    }),
  );

  it.effect("ignores a finished successful system job without requiring root", () =>
    Effect.gen(function* () {
      const state = setup({
        system: "state = not running\nlast exit code = 0",
        removalDenied: true,
      });
      yield* make.discard();
      expect(state.jobs.has(systemTarget)).toBe(true);
      expect(state.removed).toEqual([]);
    }),
  );
  it.effect("does not extend user-stage ownership to a running system job", () =>
    Effect.gen(function* () {
      const state = setup({
        user: "state = running\npid = 42",
        system: "state = running\npid = 84",
      });
      yield* make.discard({ ownStaged: true }).pipe(Effect.flip);
      expect(state.removed).toEqual([]);
      expect(state.jobs.size).toBe(2);
    }),
  );

  it.effect("accepts a job disappearing during removal only after verifying absence", () =>
    Effect.gen(function* () {
      setup({ user: "state = waiting", disappearing: true });
      yield* make.discard();
    }),
  );
  it.effect.each(["update-downloaded", "update-not-available", "error"])(
    "settles native staging on %s before shutdown can proceed",
    (terminal) =>
      Effect.gen(function* () {
        nativeUpdater.once.mockClear();
        nativeUpdater.removeListener.mockClear();
        nativeUpdater.checkForUpdates.mockClear();
        const stage = yield* make.stage.pipe(
          Effect.exit,
          Effect.forkChild({ startImmediately: true }),
        );
        expect(nativeUpdater.checkForUpdates).toHaveBeenCalledOnce();
        const listener = nativeUpdater.once.mock.calls.find(([event]) => event === terminal)?.[1];
        expect(listener).toBeTypeOf("function");
        listener(new Error("Synthetic native staging failure"));
        const exit = yield* Fiber.join(stage);
        expect(exit._tag).toBe(terminal === "update-downloaded" ? "Success" : "Failure");
        expect(nativeUpdater.removeListener.mock.calls.map(([event]) => event).sort()).toEqual([
          "error",
          "update-downloaded",
          "update-not-available",
        ]);
      }),
  );
});
