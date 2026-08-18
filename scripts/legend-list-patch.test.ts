import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const WEB_BUILDS = ["react-native.web.js", "react-native.web.mjs", "react.js", "react.mjs"];

it.layer(NodeServices.layer)("LegendList web patch", (it) => {
  it.effect("tracks CSSOM-serialized temporary padding in every web build", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const patch = yield* fs.readFileString(
        path.join(import.meta.dirname, "../patches/@legendapp__list@3.3.5.patch"),
      );

      for (const build of WEB_BUILDS) {
        const section = patch
          .split(`diff --git a/${build} b/${build}`)[1]
          ?.split("\ndiff --git ")[0];
        assert.ok(section, `missing patch for ${build}`);

        const assignmentIndex = section.indexOf(
          "contentNode.style[axis.paddingEndProp] = temporaryPaddingEnd;",
        );
        const serializedValueIndex = section.indexOf(
          "+              value: contentNode.style[axis.paddingEndProp]",
        );
        assert.ok(assignmentIndex >= 0, `missing temporary padding assignment in ${build}`);
        assert.ok(
          serializedValueIndex > assignmentIndex,
          `temporary padding in ${build} must be tracked after CSSOM serialization`,
        );
      }
    }),
  );
});
