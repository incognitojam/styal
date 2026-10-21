import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { afterEach, vi } from "vite-plus/test";
import { repointLauncher, resolveLauncherPath, resolveNewestVersion } from "./update.ts";

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
