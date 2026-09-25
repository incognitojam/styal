import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveAddProjectDefaultDirectory } from "./AddProjectDefaultDirectory.ts";

const onMac = Effect.provideService(HostProcessPlatform, "darwin");
const onLinux = Effect.provideService(HostProcessPlatform, "linux");

it.layer(NodeServices.layer)("resolveAddProjectDefaultDirectory", (it) => {
  it.effect("starts in ~/Developer on macOS when the directory exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* fileSystem.makeTempDirectoryScoped();

      expect(yield* resolveAddProjectDefaultDirectory({ homeDir }).pipe(onMac)).toBe("~/");

      yield* fileSystem.writeFileString(path.join(homeDir, "Developer"), "");
      expect(yield* resolveAddProjectDefaultDirectory({ homeDir }).pipe(onMac)).toBe("~/");

      yield* fileSystem.remove(path.join(homeDir, "Developer"));
      yield* fileSystem.makeDirectory(path.join(homeDir, "Developer"));
      expect(yield* resolveAddProjectDefaultDirectory({ homeDir }).pipe(onMac)).toBe(
        "~/Developer/",
      );
      expect(yield* resolveAddProjectDefaultDirectory({ homeDir }).pipe(onLinux)).toBe("~/");
    }).pipe(Effect.scoped),
  );
});
