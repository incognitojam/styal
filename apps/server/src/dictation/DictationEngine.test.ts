import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as DictationEngine from "./DictationEngine.ts";

// Unit tests cover availability reporting and error paths. Streaming against
// the real sidecar and model is exercised by the spike's harness
// (native/dictation-spike/parakeet-sidecar/client.mjs) — it needs a ~600MB
// model download, which has no place in the unit suite.

const engineWith = (overrides: { dictationModelPath?: string }) =>
  DictationEngine.layer.pipe(
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return { ...config, ...overrides };
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-dictation-test-" }).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

describe("DictationEngine", () => {
  it.effect("reports unavailable with a reason when no model is configured", () =>
    Effect.gen(function* () {
      const engine = yield* DictationEngine.DictationEngine;
      const status = yield* engine.status;
      assert.equal(status.available, false);
      assert.match(status.reason ?? "", /no dictation model configured/);
      assert.equal(status.warm, false);
    }).pipe(Effect.provide(engineWith({}))),
  );

  it.effect("reports unavailable when the configured model file does not exist", () =>
    Effect.gen(function* () {
      const engine = yield* DictationEngine.DictationEngine;
      const status = yield* engine.status;
      assert.equal(status.available, false);
      assert.match(status.reason ?? "", /not found at \/nonexistent\/model.gguf/);
    }).pipe(Effect.provide(engineWith({ dictationModelPath: "/nonexistent/model.gguf" }))),
  );

  it.effect("fails an utterance stream with DictationUnavailable when unconfigured", () =>
    Effect.gen(function* () {
      const engine = yield* DictationEngine.DictationEngine;
      const result = yield* engine
        .stream(Stream.make(new Uint8Array(6400)))
        .pipe(Stream.runDrain, Effect.flip);
      assert.equal(result._tag, "DictationUnavailable");
    }).pipe(Effect.provide(engineWith({}))),
  );
});
