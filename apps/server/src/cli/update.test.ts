import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Command } from "effect/cli";
import { afterEach, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { pinnedRuntimePaths } from "../cloud/pinnedRuntime.ts";
import {
  repointLauncher,
  resolveLauncherPath,
  resolveNewestVersion,
  updateCommand,
} from "./update.ts";

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
        versionsDir: path.join(root, "runtime/styal-executable/versions"),
        targetEntryPath: newExe,
      });

      assert.deepStrictEqual(Option.getOrUndefined(repointed), launcher);
      assert.equal(yield* fs.readLink(launcher), newExe);
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
          versionsDir: path.join(root, "runtime/styal-executable/versions"),
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

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("styal update service", (it) => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "reports the service switch as pending after installing the target runtime",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-service-" });
        const targetVersion = "999.0.0";
        const runtime = pinnedRuntimePaths(path, baseDir, targetVersion, "linux");
        yield* fs.makeDirectory(runtime.versionDir, { recursive: true });
        yield* fs.writeFileString(
          runtime.entryPath,
          `#!/bin/sh\nprintf 't3 v${targetVersion}\\n'\n`,
        );
        yield* fs.chmod(runtime.entryPath, 0o755);
        yield* fs.writeFileString(runtime.sentinelPath, `${targetVersion}\n`);
        const logPath = path.join(baseDir, "userdata/logs/boot-service.log");
        const unitPath = path.join(baseDir, "t3code.service");
        const installs: Array<Parameters<BootService.BootService["Service"]["install"]>[0]> = [];
        vi.spyOn(BootService, "layer").mockReturnValue(
          Layer.succeed(BootService.BootService, {
            status: Effect.succeed({
              supported: true,
              installed: true,
              current: true,
              installedVersion: packageJson.version,
              installedBaseDir: baseDir,
              logPath,
              unitPath,
            }),
            install: (options) =>
              Effect.sync(() => {
                installs.push(options);
                return {
                  program: [runtime.entryPath],
                  baseDir,
                  logPath,
                  unitPath,
                  handedOff: true,
                };
              }),
            restart: Effect.die("unexpected restart"),
            uninstall: Effect.die("unexpected uninstall"),
            withStopped: () => Effect.die("unexpected maintenance"),
          }),
        );
        const lines: string[] = [];
        yield* Command.runWith(updateCommand, { version: packageJson.version })([
          targetVersion,
          "--yes",
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(Console.Console, {
            ...globalThis.console,
            log: (...args) => {
              lines.push(args.map(String).join(" "));
            },
          }),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        );

        expect(installs).toEqual([{ allowDowngrade: false, start: true }]);
        const output = lines.join("\n");
        expect(output).not.toContain("Background service restarted");
        expect(output).toContain(`Background service switching to ${targetVersion}`);
        expect(output).toContain(logPath);
      }),
  );
});
