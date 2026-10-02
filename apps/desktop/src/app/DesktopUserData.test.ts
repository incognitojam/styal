import * as NodePath from "@effect/platform-node/NodePath";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect("keeps installed credentials in the existing styal profile across the V2 upgrade", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* resolveUserDataPath({ appDataDirectory: "/profiles", safeStorageName: "styal" }),
      "/profiles/styal",
    );
    assert.equal(
      yield* resolveUserDataPath({
        appDataDirectory: "/profiles",
        safeStorageName: "styal-preview",
      }),
      "/profiles/styal-preview",
    );
    assert.equal(
      yield* resolveUserDataPath({ appDataDirectory: "/profiles", safeStorageName: "styal-dev" }),
      "/profiles/styal-dev",
    );
  }).pipe(Effect.provide(NodePath.layer)),
);
