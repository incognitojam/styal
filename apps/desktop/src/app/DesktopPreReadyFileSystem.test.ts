import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";
import * as DesktopUserData from "./DesktopUserData.ts";

const resolveWindowsUserData = (appDataDirectory: string) =>
  DesktopUserData.resolveUserDataPath({
    appDataDirectory,
    safeStorageName: "styal",
  }).pipe(Effect.provide(DesktopPreReadyFileSystem.layer));

it.layer(NodeServices.layer)("DesktopPreReadyFileSystem", (it) => {
  it.effect("keeps the styal profile separate from a legacy upstream profile", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const scratch = NodeURL.fileURLToPath(new URL("../../../../.scratch/", import.meta.url));
      yield* fileSystem.makeDirectory(scratch, { recursive: true });
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "upstream-v2-profile-",
        directory: scratch,
      });
      yield* fileSystem.makeDirectory(path.join(root, "T3 Code (Alpha)"));
      yield* fileSystem.writeFileString(path.join(root, "T3 Code (Alpha)", "Local State"), "keys");

      const userData = yield* resolveWindowsUserData(root);

      assert.equal(userData, path.join(root, "styal"));
      assert.isFalse(yield* fileSystem.exists(userData));
      assert.equal(
        yield* fileSystem.readFileString(path.join(root, "T3 Code (Alpha)", "Local State")),
        "keys",
      );
    }),
  );
});
