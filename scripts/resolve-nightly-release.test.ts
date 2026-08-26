import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  readStyalBaseVersion,
  resolveNightlyBaseVersion,
  resolveNightlyReleaseMetadata,
  validateStyalBaseVersion,
  writeNightlyReleaseOutput,
} from "./resolve-nightly-release.ts";

it("strips prerelease and build metadata when deriving the nightly base version", () => {
  assert.equal(resolveNightlyBaseVersion("0.0.17"), "0.0.17");
  assert.equal(resolveNightlyBaseVersion("9.9.9-smoke.0"), "9.9.9");
  assert.equal(resolveNightlyBaseVersion("1.2.3-beta.4+build.9"), "1.2.3");
});

it.effect("uses the declared version as the nightly base without bumping it", () =>
  Effect.gen(function* () {
    // styal-version.json names the next version to ship, so nightlies are its
    // prereleases and promotion publishes that exact number.
    assert.equal(yield* validateStyalBaseVersion("0.1.0"), "0.1.0");
    assert.equal(yield* validateStyalBaseVersion("9.9.9-smoke.0"), "9.9.9");
    assert.equal(yield* validateStyalBaseVersion("1.2.3-beta.4+build.9"), "1.2.3");
  }),
);

it.effect("reports the invalid styal version", () =>
  Effect.gen(function* () {
    const error = yield* validateStyalBaseVersion("nightly").pipe(Effect.flip);

    assert.equal(error._tag, "InvalidStyalVersionError");
    assert.equal(error.version, "nightly");
    assert.equal(error.message, "Invalid styal version 'nightly'.");
  }),
);

it("derives nightly metadata including the short commit sha in the release name", () => {
  assert.deepStrictEqual(
    resolveNightlyReleaseMetadata("9.9.10", "20260413", 321, "abcdef1234567890"),
    {
      baseVersion: "9.9.10",
      version: "9.9.10-nightly.20260413.321",
      tag: "v9.9.10-nightly.20260413.321",
      name: "T3 Code Nightly 9.9.10-nightly.20260413.321 (abcdef123456)",
      shortSha: "abcdef123456",
    },
  );
});

it.effect("preserves the GITHUB_OUTPUT configuration cause", () => {
  const metadata = resolveNightlyReleaseMetadata("1.2.4", "20260620", 42, "abcdef1234567890");
  const configCause = new ConfigProvider.SourceError({ message: "environment unavailable" });

  return Effect.gen(function* () {
    const configError = yield* writeNightlyReleaseOutput(metadata, true).pipe(
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.make(() => Effect.fail(configCause)),
      ),
      Effect.flip,
    );

    if (configError._tag !== "NightlyReleaseGitHubOutputConfigError") {
      return assert.fail(`Unexpected error: ${configError._tag}`);
    }
    assert.instanceOf(configError.cause, Config.ConfigError);
    assert.strictEqual(configError.cause.cause, configCause);
    assert.notInclude(configError.message, configCause.message);
  });
});

it.layer(NodeServices.layer)("readStyalBaseVersion", (it) => {
  it.effect("preserves styal version file read context and its platform cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "resolve-nightly-release-read-",
      });
      const versionFilePath = path.join(rootDir, "styal-version.json");

      const error = yield* readStyalBaseVersion(rootDir).pipe(Effect.flip);

      if (error._tag !== "NightlyReleaseVersionFileError") {
        return assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "read");
      assert.equal(error.versionFilePath, versionFilePath);
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.notInclude(error.message, String((error.cause as Error).message));
    }),
  );

  it.effect("preserves styal version file decode context and its schema cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "resolve-nightly-release-decode-",
      });
      const versionFilePath = path.join(rootDir, "styal-version.json");
      yield* fs.writeFileString(versionFilePath, "{");

      const error = yield* readStyalBaseVersion(rootDir).pipe(Effect.flip);

      if (error._tag !== "NightlyReleaseVersionFileError") {
        return assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "decode");
      assert.equal(error.versionFilePath, versionFilePath);
      assert.ok(error.cause !== undefined);
      assert.notInclude(error.message, String((error.cause as Error).message));
    }),
  );
});
