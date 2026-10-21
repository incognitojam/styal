import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  resolveUnreleasedBaseVersion,
  validateStyalBaseVersion,
} from "./resolve-nightly-release.ts";

it.effect("uses the declared version as the nightly base without bumping it", () =>
  Effect.gen(function* () {
    // styal-version.json names the next version to ship, so nightlies are its
    // prereleases and promotion publishes that exact number.
    assert.equal(yield* validateStyalBaseVersion("0.1.0"), "0.1.0");
    assert.equal(yield* validateStyalBaseVersion("9.9.9-smoke.0"), "9.9.9");
    assert.equal(yield* validateStyalBaseVersion("1.2.3-beta.4+build.9"), "1.2.3");
  }),
);

it.effect("keeps the declared version until a stable release reaches it", () =>
  Effect.gen(function* () {
    assert.equal(yield* resolveUnreleasedBaseVersion("0.1.0", undefined), "0.1.0");
    assert.equal(yield* resolveUnreleasedBaseVersion("0.1.0", "v0.0.9"), "0.1.0");
    // A deliberate minor bump wins over the next patch of the last stable.
    assert.equal(yield* resolveUnreleasedBaseVersion("0.2.0", "v0.1.4"), "0.2.0");
  }),
);

it.effect("previews the next patch once the declared version is released", () =>
  Effect.gen(function* () {
    assert.equal(yield* resolveUnreleasedBaseVersion("0.1.0", "v0.1.0"), "0.1.1");
    assert.equal(yield* resolveUnreleasedBaseVersion("0.1.0", "v0.1.3"), "0.1.4");
    assert.equal(yield* resolveUnreleasedBaseVersion("0.1.9", "v0.2.0"), "0.2.1");
  }),
);

it.effect("rejects a latest stable tag that is not a plain version", () =>
  Effect.gen(function* () {
    const error = yield* resolveUnreleasedBaseVersion("0.1.0", "v0.1.0-nightly.20260926.1").pipe(
      Effect.flip,
    );

    assert.equal(error._tag, "InvalidStyalVersionError");
    assert.equal(error.version, "v0.1.0-nightly.20260926.1");
  }),
);
