import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ManagedUpdatesPolicy } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { afterEach, vi } from "vite-plus/test";

import * as BootService from "../cloud/bootService.ts";
import { prunePinnedRuntimes } from "../cloud/pinnedRuntime.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import { repointLauncher, resolveLauncherPath, resolveNewestVersion, runUpdate } from "./update.ts";

// lsof listing one process, so prune sees a process list in which no runtime is running.
const unrelatedLsof = ProcessRunner.ProcessRunner.of({
  run: () =>
    Effect.succeed({
      stdout: "p1\nftxt\nn/usr/bin/true\n",
      stderr: "",
      code: ChildProcessSpawner.ExitCode(0),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    }),
});

afterEach(() => vi.restoreAllMocks());

it.effect("resolves each CLI channel with one small npm request", () =>
  Effect.gen(function* () {
    const requests: string[] = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            latest: "1.2.3",
            nightly: "1.2.4-nightly.20261011.9",
            preview: "1.2.4-preview.20261010.2",
          }),
        );
      }),
    );
    for (const [channel, version] of [
      ["stable", "1.2.3"],
      ["nightly", "1.2.4-nightly.20261011.9"],
      ["preview", "1.2.4-preview.20261010.2"],
    ] as const) {
      assert.equal(
        yield* resolveNewestVersion(channel).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        ),
        version,
      );
    }
    const tagsUrl = "https://registry.npmjs.org/-/package/@styal/cli/dist-tags";
    const checksumsUrl = (version: string) =>
      `https://github.com/incognitojam/styal/releases/download/v${version}/SHA256SUMS`;
    assert.deepEqual(requests, [
      tagsUrl,
      checksumsUrl("1.2.3"),
      tagsUrl,
      checksumsUrl("1.2.4-nightly.20261011.9"),
      tagsUrl,
      checksumsUrl("1.2.4-preview.20261010.2"),
    ]);
  }),
);

it.layer(NodeServices.layer)("styal update under a managed policy", (it) => {
  const runWithPolicy = (
    updates: ManagedUpdatesPolicy,
    input: { readonly channel?: "stable" | "nightly"; readonly requestedVersion?: string } = {},
  ) =>
    runUpdate({
      baseDir: "/unused",
      logsDir: "/unused",
      serverRuntimeStatePath: "/unused",
      channel: input.channel,
      requestedVersion: input.requestedVersion,
      allowDowngrade: false,
      assumeYes: true,
    }).pipe(
      Effect.flip,
      Effect.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest({
            schemaVersion: 1,
            organization: "Example Corp",
            limits: { updates },
          }),
          // Refusals happen before the update touches the network, the service, or a process.
          Layer.mock(BootService.BootService, {}),
          Layer.mock(ProcessRunner.ProcessRunner, {}),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("unexpected release lookup")),
          ),
        ),
      ),
    );

  it.effect("refuses to update when updates are off", () =>
    Effect.gen(function* () {
      const error = yield* runWithPolicy({ mode: "off" });
      assert.equal(error.message, "Example Corp manages styal updates.");
    }),
  );

  it.effect("refuses nightly releases when the policy disallows them", () =>
    Effect.gen(function* () {
      const byChannel = yield* runWithPolicy(
        { mode: "auto", allowNightly: false },
        { channel: "nightly" },
      );
      const byVersion = yield* runWithPolicy(
        { mode: "auto", allowNightly: false },
        { channel: "stable", requestedVersion: "1.2.0-nightly.20261028.1" },
      );
      for (const error of [byChannel, byVersion]) {
        assert.equal(
          error.message,
          "Example Corp manages styal updates. Only stable releases can be installed.",
        );
      }
    }),
  );
});

it.effect("does not offer a version whose release archives are not published yet", () =>
  Effect.gen(function* () {
    const requests: string[] = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(`${request.method} ${request.url}`);
        return HttpClientResponse.fromWeb(
          request,
          request.method === "HEAD"
            ? new Response(null, { status: 404 })
            : Response.json({ nightly: "1.2.4-nightly.20261011.9" }),
        );
      }),
    );
    const error = yield* resolveNewestVersion("nightly", "https://mirror.example/styal").pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.flip,
    );
    assert.equal(
      error.message,
      "styal 1.2.4-nightly.20261011.9 is still being published. Try again in a few minutes.",
    );
    assert.equal(
      requests[1],
      "HEAD https://mirror.example/styal/v1.2.4-nightly.20261011.9/SHA256SUMS",
    );
  }),
);

it.effect("fails CLI discovery without retries or a fallback", () =>
  Effect.gen(function* () {
    for (const response of [
      new Response(null, { status: 429 }),
      new Response("invalid json"),
      Response.json({}),
      Response.json({ latest: "1.2.3-nightly.20261011.9" }),
      Response.json({ latest: "garbage" }),
      Response.json({ latest: 123 }),
    ]) {
      let requests = 0;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests++;
          return HttpClientResponse.fromWeb(request, response);
        }),
      );
      const error = yield* resolveNewestVersion("stable").pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.flip,
      );
      assert.equal(error._tag, "CliUpdateError");
      assert.equal(requests, 1);
    }
  }),
);

it.effect("bounds a stalled CLI release response body", () =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(new ReadableStream()))),
    );
    const check = yield* resolveNewestVersion("nightly").pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.flip,
      Effect.forkChild,
    );
    yield* TestClock.adjust("30 seconds");
    assert.equal((yield* Fiber.join(check)).message, "Timed out checking styal releases.");
  }),
);

it.layer(NodeServices.layer)("styal update launcher", (it) => {
  it.effect("repoints a symlink that lives in a runtime versions tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "styal-update-" });
      const oldExe = path.join(root, "runtime/styal-executable/versions/1.0.0/styal");
      const newExe = path.join(root, "runtime/styal-executable/versions/2.0.0/styal");
      const launcher = path.join(root, "bin/styal");
      for (const file of [oldExe, newExe]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.symlink(oldExe, launcher);

      const repointed = yield* repointLauncher({
        launchedAs: launcher,
        baseDir: root,
        targetEntryPath: newExe,
      });

      assert.deepStrictEqual(Option.getOrUndefined(repointed), launcher);
      assert.equal(yield* fs.readLink(launcher), newExe);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect.each([
    { name: "no launcher records", recorded: undefined },
    { name: "an empty launcher record", recorded: "" },
    { name: "whole launcher records", recorded: "/opt/styal\n" },
    { name: "Windows launcher records", recorded: "C:\\styal.cmd\r\n" },
    // An interrupted append cut this record short.
    { name: "an unterminated launcher record", recorded: "/opt/sty" },
    // Another process's append is cut short after styal update reads the records.
    { name: "a record cut short after the read", recorded: "/opt/styal\n", cut: "/opt/sty" },
  ])("keeps the runtime a repointed launcher off PATH points at with $name", ({ recorded, cut }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "styal-update-" });
      yield* TestClock.setTime(Duration.toMillis(Duration.days(1)));
      for (const version of ["1.0.0", "2.0.0"]) {
        const directory = path.join(root, "runtime/styal-executable/versions", version);
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(path.join(directory, "styal"), "");
        yield* fs.writeFileString(path.join(directory, ".install-complete"), `${version}\n`);
        yield* fs.utimes(path.join(directory, ".install-complete"), 0, 0);
      }
      if (recorded !== undefined) {
        yield* fs.writeFileString(path.join(root, "runtime/launchers"), recorded);
      }
      // A launcher in the T3 home itself, which neither PATH nor the default bin dir reaches.
      const launcher = path.join(root, "styal");
      yield* fs.symlink(path.join(root, "runtime/styal-executable/versions/1.0.0/styal"), launcher);

      const launchersFile = path.join(root, "runtime/launchers");
      yield* repointLauncher({
        launchedAs: launcher,
        baseDir: root,
        targetEntryPath: path.join(root, "runtime/styal-executable/versions/2.0.0/styal"),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (file, encoding) =>
            fs
              .readFileString(file, encoding)
              .pipe(
                Effect.tap(() =>
                  cut === undefined || file !== launchersFile
                    ? Effect.void
                    : fs.writeFileString(file, cut, { flag: "a" }),
                ),
              ),
        }),
      );
      // A later server start prunes with no idea how this machine launches styal.
      const removed = yield* prunePinnedRuntimes({ baseDir: root, keep: [] }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, unrelatedLsof),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.provideService(HostProcess.HomeDirectory, root),
      );

      assert.deepStrictEqual(removed, ["1.0.0"]);
      // macOS temp dirs sit behind the /var -> /private/var symlink, so compare canonical paths.
      assert.equal(
        yield* fs.realPath(launcher),
        yield* fs.realPath(path.join(root, "runtime/styal-executable/versions/2.0.0/styal")),
      );
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  const launcherFixture = Effect.fnUntraced(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "styal-update-" });
    const oldExe = path.join(root, "runtime/styal-executable/versions/1.0.0/styal");
    const newExe = path.join(root, "runtime/styal-executable/versions/2.0.0/styal");
    const launcher = path.join(root, "styal");
    for (const file of [oldExe, newExe]) {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, "");
    }
    yield* fs.symlink(oldExe, launcher);
    return { root, oldExe, newExe, launcher, launchersFile: path.join(root, "runtime/launchers") };
  });

  it.effect("records a relative launcher path as absolute", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, newExe, launcher, launchersFile } = yield* launcherFixture();

      yield* repointLauncher({
        launchedAs: path.relative(path.resolve("."), launcher),
        baseDir: root,
        targetEntryPath: newExe,
      });

      assert.equal(yield* fs.readFileString(launchersFile), `\n${launcher}\n`);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("fails instead of repointing a launcher it cannot record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, oldExe, newExe, launcher, launchersFile } = yield* launcherFixture();
      // Appending to a directory fails the way a read-only or full disk would.
      yield* fs.makeDirectory(launchersFile);

      const result = yield* repointLauncher({
        launchedAs: launcher,
        baseDir: root,
        targetEntryPath: newExe,
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(result));
      assert.equal(yield* fs.readLink(launcher), oldExe);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect.each(["recording", "repointing"] as const)(
    "never leaves a repointed launcher unrecorded when styal update dies while %s",
    (step) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { root, newExe, launcher, launchersFile } = yield* launcherFixture();

        yield* repointLauncher({
          launchedAs: launcher,
          baseDir: root,
          targetEntryPath: newExe,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            writeFileString: (path, data, options) =>
              step === "recording" && path === launchersFile
                ? Effect.die("styal update was killed")
                : fs.writeFileString(path, data, options),
            rename: (from, to) =>
              step === "repointing" && to === launcher
                ? Effect.die("styal update was killed")
                : fs.rename(from, to),
          }),
          Effect.exit,
        );

        const repointed = (yield* fs.readLink(launcher)) === newExe;
        const recorded = (yield* fs
          .readFileString(launchersFile)
          .pipe(Effect.orElseSucceed(() => "")))
          .split("\n")
          .includes(launcher);
        assert.isFalse(repointed && !recorded);
      }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("leaves a plain copy or a foreign symlink alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "styal-update-" });
      const newExe = path.join(root, "runtime/styal-executable/versions/2.0.0/styal");
      const copy = path.join(root, "copy/styal");
      const foreign = path.join(root, "foreign/styal");
      const elsewhere = path.join(root, "elsewhere/styal");
      const otherHome = path.join(root, "other/runtime/styal-executable/versions/1.0.0/styal");
      const otherLauncher = path.join(root, "other/bin/styal");
      for (const file of [newExe, copy, elsewhere, otherHome]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(foreign), { recursive: true });
      yield* fs.symlink(elsewhere, foreign);
      yield* fs.makeDirectory(path.dirname(otherLauncher), { recursive: true });
      yield* fs.symlink(otherHome, otherLauncher);

      for (const launchedAs of [copy, foreign, otherLauncher, undefined]) {
        const repointed = yield* repointLauncher({
          launchedAs,
          baseDir: root,
          targetEntryPath: newExe,
        });
        assert.equal(repointed._tag, "None", launchedAs ?? "undefined");
      }
      assert.equal(yield* fs.readLink(foreign), elsewhere);
      assert.equal(yield* fs.readLink(otherLauncher), otherHome);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("finds the launcher a bare command name resolved to on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "styal-update-" });
      const launcher = path.join(root, "bin/styal");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(launcher, "");

      const bare = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcess.InvokedAs, "styal"),
        Effect.provideService(HostProcess.Environment, {
          PATH: `${path.join(root, "missing")}:${path.join(root, "bin")}`,
        }),
        Effect.provideService(HostProcess.WorkingDirectory, root),
      );
      const relative = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcess.InvokedAs, "./bin/styal"),
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.provideService(HostProcess.WorkingDirectory, root),
      );
      const absent = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcess.InvokedAs, "styal"),
        Effect.provideService(HostProcess.Environment, { PATH: path.join(root, "missing") }),
        Effect.provideService(HostProcess.WorkingDirectory, root),
      );

      assert.equal(bare, launcher);
      assert.equal(relative, launcher);
      assert.equal(absent, undefined);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );
});
