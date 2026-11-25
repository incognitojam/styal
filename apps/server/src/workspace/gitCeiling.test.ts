// @effect-diagnostics processEnvInEffect:off - these fixtures isolate the environment inherited by real children.
import { vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as PhysicalFileSystem from "@t3tools/shared/PhysicalFileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { fixture, nodeLayer } from "../worktreeCleanup/fixtures.testkit.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Path from "effect/Path";
import * as NetService from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as Checkout from "../worktreeCleanup/Checkout.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as References from "effect/References";
import * as Option from "effect/Option";
import { OpenSpans } from "../observability/OpenSpans.ts";
import { FetchHttpClient, HttpClient } from "effect/http";
// @effect-diagnostics nodeBuiltinImport:off - observing the real listener before database startup.
import * as NodeHttp from "node:http";
import { makeAppendGitCeilings, start } from "./gitCeiling.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";

const isolateCeiling = Effect.acquireRelease(
  Effect.sync(() => {
    const inherited = process.env.GIT_CEILING_DIRECTORIES;
    delete process.env.GIT_CEILING_DIRECTORIES;
    return inherited;
  }),
  (inherited) =>
    Effect.sync(() => {
      if (inherited === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = inherited;
    }),
);

it.effect.each([
  {
    platform: "linux",
    directory: "/alias/managed",
    real: "/real/managed",
    inherited: ":/previous::",
    expected: ":/previous:::/real/managed",
    next: "/next",
  },
  {
    platform: "win32",
    directory: "C:\\alias\\managed",
    real: "C:\\real\\managed",
    inherited: ";D:\\previous;;",
    expected: ";D:\\previous;;;C:\\real\\managed",
    next: "E:\\next",
  },
] as const)("appends real managed paths and retains old paths on $platform", (row) =>
  Effect.gen(function* () {
    yield* isolateCeiling;
    process.env.GIT_CEILING_DIRECTORIES = row.inherited;
    const env = { ...process.env };
    const physical = yield* PhysicalFileSystem.PhysicalFileSystem;
    using _real = vi
      .spyOn(physical, "realpath")
      .mockImplementation(async (value) =>
        String(value) === row.directory ? row.real : String(value),
      );
    const append = yield* makeAppendGitCeilings.pipe(
      Effect.provideService(HostProcess.Environment, env),
    );
    yield* append([row.directory]);
    expect(process.env.GIT_CEILING_DIRECTORIES).toBe(row.expected);
    expect(env.GIT_CEILING_DIRECTORIES).toBe(row.expected);
    yield* append([row.directory, row.next]);
    expect(env.GIT_CEILING_DIRECTORIES).toBe(
      `${row.expected}${row.platform === "win32" ? ";" : ":"}${row.next}`,
    );
  }).pipe(Effect.provideService(HostProcess.Platform, row.platform), Effect.provide(nodeLayer)),
);

it.effect("skips an unrepresentable directory and logs it only once", () => {
  const warnings: unknown[] = [];
  return Effect.gen(function* () {
    yield* isolateCeiling;
    process.env.GIT_CEILING_DIRECTORIES = ":/previous::";
    const env = { ...process.env };
    const physical = yield* PhysicalFileSystem.PhysicalFileSystem;
    using _real = vi.spyOn(physical, "realpath").mockImplementation(async (value) => String(value));
    const append = yield* makeAppendGitCeilings.pipe(
      Effect.provideService(HostProcess.Environment, env),
    );
    yield* append(["/managed:separator"]);
    yield* append(["/managed:separator"]);
    expect(env.GIT_CEILING_DIRECTORIES).toBe(":/previous::");
    expect(warnings).toHaveLength(1);
  }).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provide(
      Layer.mergeAll(
        nodeLayer,
        Logger.layer([Logger.make(({ message }) => warnings.push(message))], {
          mergeWithExisting: false,
        }),
      ),
    ),
  );
});

it.live("bounds Git through assembled server startup before database initialization", () =>
  Effect.gen(function* () {
    const environment = yield* HostProcess.Environment;
    const inherited = environment.GIT_CEILING_DIRECTORIES;
    const pruning = process.env.T3CODE_EVENT_PRUNING;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        environment.GIT_CEILING_DIRECTORIES = "";
        process.env.T3CODE_EVENT_PRUNING = "0";
      }),
      () =>
        Effect.sync(() => {
          if (inherited === undefined) delete environment.GIT_CEILING_DIRECTORIES;
          else environment.GIT_CEILING_DIRECTORIES = inherited;
          if (pruning === undefined) delete process.env.T3CODE_EVENT_PRUNING;
          else process.env.T3CODE_EVENT_PRUNING = pruning;
        }),
    );
    const f = yield* fixture;
    const path = yield* Path.Path;
    const managed = path.join(f.base, "configured-managed");
    const worktree = path.join(managed, "fixture", "topic");
    yield* f.fs.makeDirectory(path.dirname(worktree), { recursive: true });
    yield* f.command(f.root, ["worktree", "move", f.worktree, worktree]);
    yield* f.command(f.base, ["init", "-b", "main"]);
    yield* f.command(f.base, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    yield* f.fs.writeFileString(path.join(worktree, "note.txt"), "keep");
    const state = () =>
      Effect.forEach(
        [["rev-parse", "HEAD"], ["ls-files", "--stage", "-z"], ["for-each-ref"]],
        (args) => f.command(f.base, args).pipe(Effect.map((result) => result.stdout)),
      );
    const before = yield* state();
    yield* f.fs.remove(`${worktree}/.git`);
    const physical = yield* PhysicalFileSystem.PhysicalFileSystem;
    const beforeRoot = (yield* f.command(worktree, ["rev-parse", "--show-toplevel"])).stdout.trim();
    expect(yield* Effect.promise(() => physical.realpath(beforeRoot))).toBe(
      yield* Effect.promise(() => physical.realpath(f.base)),
    );
    const config = { ...f.config, cwd: f.root, host: "127.0.0.1", noBrowser: true };
    yield* f.fs.writeFileString(
      config.settingsPath,
      JSON.stringify({
        worktreesDirectory: managed,
        autoUpdateProviders: false,
        enableProviderUpdateChecks: false,
        regenerableFileCleanupMigrated: true,
        providerInstances: Object.fromEntries(
          [
            "codex",
            "claudeAgent",
            "cursor",
            "grok",
            "fx",
            "opencode",
            "antigravity",
            "kiro",
            "pi",
            "muse",
          ].map((driver) => [driver, { driver, enabled: false }]),
        ),
      }),
    );
    const listening = vi.spyOn(NodeHttp.Server.prototype, "listen");
    using _listening = listening;
    const persistence = SqlitePersistence.layerConfig;
    using _database = vi.spyOn(SqlitePersistence, "layerConfig", "get").mockReturnValue(
      Layer.unwrap(
        Effect.gen(function* () {
          const listener = listening.mock.contexts.find(
            (server) => server instanceof NodeHttp.Server && server.listening,
          );
          expect(listener).toBeDefined();
          const address = (listener as NodeHttp.Server).address();
          expect(address !== null && typeof address !== "string").toBe(true);
          if (address !== null && typeof address !== "string") {
            const response = yield* HttpClient.get(`http://127.0.0.1:${address.port}`).pipe(
              Effect.provide(FetchHttpClient.layer),
              Effect.orDie,
            );
            expect(response.status).toBe(503);
          }
          expect(yield* References.MinimumLogLevel).toBe(config.logLevel);
          expect(Option.isSome(yield* Effect.serviceOption(OpenSpans))).toBe(true);
          return persistence;
        }),
      ),
    );
    const server = yield* Effect.promise(() => import("../server.ts"));
    const services = yield* Layer.build(
      server.layer.pipe(Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config))),
    );
    const git = Context.get(services, GitVcsDriver.GitVcsDriver);
    for (const args of [
      ["rev-parse", "--show-toplevel"],
      ["branch", "wrong-repository"],
    ]) {
      const result = yield* git.execute({
        operation: "test.ceiling",
        cwd: worktree,
        args,
        allowNonZeroExit: true,
      });
      expect(result.exitCode).not.toBe(0);
    }
    expect(
      process.env.GIT_CEILING_DIRECTORIES?.startsWith(
        (yield* HostProcess.Platform) === "win32" ? ";" : ":",
      ),
    ).toBe(true);
    expect(yield* state()).toEqual(before);
    expect(yield* f.fs.readFileString(`${worktree}/note.txt`)).toBe("keep");
  }).pipe(Effect.provide(Layer.merge(nodeLayer, NetService.layer))),
);

it.live.skipIf(!symlinksSupported)(
  "canonicalizes a missing managed directory through its existing symlinked parent",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const path = yield* Path.Path;
      const physical = yield* PhysicalFileSystem.PhysicalFileSystem;
      const real = path.join(f.base, "real");
      const alias = path.join(f.base, "alias");
      yield* f.fs.makeDirectory(real);
      yield* Effect.promise(() => physical.symlink(real, alias, "junction"));
      yield* f.command(f.base, ["init"]);
      const environment = yield* HostProcess.Environment;
      const inherited = environment.GIT_CEILING_DIRECTORIES;
      yield* Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          if (inherited === undefined) delete environment.GIT_CEILING_DIRECTORIES;
          else environment.GIT_CEILING_DIRECTORIES = inherited;
        }),
      );
      const append = yield* makeAppendGitCeilings;
      yield* append([path.join(alias, "missing", "managed")]);
      const cwd = path.join(alias, "missing", "managed", "fixture", "topic");
      yield* f.fs.makeDirectory(cwd, { recursive: true });
      const checkoutRoot = yield* Checkout.makeCheckoutRoot;
      expect(yield* checkoutRoot(cwd)).toBe(yield* Effect.promise(() => physical.realpath(cwd)));
      expect(
        (yield* f.git.execute({
          operation: "test.ceiling",
          cwd,
          args: ["rev-parse", "--show-toplevel"],
          allowNonZeroExit: true,
        })).exitCode,
      ).not.toBe(0);
    }).pipe(Effect.provide(nodeLayer)),
);

it.effect(
  "initializes settings and appends changed directories to both process and injected environments",
  () =>
    Effect.gen(function* () {
      yield* isolateCeiling;
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const first = path.join(config.baseDir, "first");
      const second = path.join(config.baseDir, "second");
      const physical = yield* PhysicalFileSystem.PhysicalFileSystem;
      using _real = vi
        .spyOn(physical, "realpath")
        .mockImplementation(async (value) => String(value));
      const settings = yield* ServerSettings.ServerSettingsService;
      const initial = { ...(yield* settings.getSettings), worktreesDirectory: first };
      const environment = { ...process.env };
      const updater = yield* start().pipe(
        Effect.provideService(HostProcess.Environment, environment),
        Effect.provideService(ServerSettings.ServerSettingsService, {
          ...settings,
          getSettings: Effect.succeed(initial),
          subscribeChanges: Effect.succeed(Stream.make({ ...initial, worktreesDirectory: second })),
        }),
      );
      yield* Fiber.join(updater);
      const entries = process.env.GIT_CEILING_DIRECTORIES?.split(
        (yield* HostProcess.Platform) === "win32" ? ";" : ":",
      );
      expect(entries).toEqual([config.worktreesDir, first, second]);
      expect(environment.GIT_CEILING_DIRECTORIES).toBe(process.env.GIT_CEILING_DIRECTORIES);
    }).pipe(
      Effect.provide(
        Layer.merge(
          ServerSettings.layerTest(),
          ServerConfig.layerTest("/project", { prefix: "ceiling-settings-" }),
        ).pipe(Layer.provideMerge(nodeLayer)),
      ),
    ),
);
