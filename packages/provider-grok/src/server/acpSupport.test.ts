import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as EffectAcpErrors from "effect-acp/errors";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  grokAcpSpawnArgs,
} from "./acpSupport.ts";

describe("grokAcpSpawnArgs", () => {
  it("inherits the Grok CLI config when no T3 runtime mode is set", () => {
    expect(grokAcpSpawnArgs()).toEqual(["agent", "stdio"]);
  });

  it("forces Grok to ask when T3 is Supervised", () => {
    expect(grokAcpSpawnArgs("approval-required")).toEqual([
      "--permission-mode",
      "default",
      "agent",
      "stdio",
    ]);
  });

  it("maps Full access to Grok always-approve", () => {
    expect(grokAcpSpawnArgs("full-access")).toEqual(["agent", "--always-approve", "stdio"]);
  });

  it("launches Auto on Grok's classifier and a mode Grok does not offer asking", () => {
    expect(grokAcpSpawnArgs("auto")).toEqual(["--permission-mode", "auto", "agent", "stdio"]);
    expect(grokAcpSpawnArgs("auto-accept-edits")).toEqual([
      "--permission-mode",
      "default",
      "agent",
      "stdio",
    ]);
  });
});

describe("buildGrokAcpSpawnInput", () => {
  it.effect("does not hand the server's own variables to the Grok process", () =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = {
            T3CODE_PORT: process.env.T3CODE_PORT,
            GROK_TEST_INHERITED: process.env.GROK_TEST_INHERITED,
          };
          process.env.T3CODE_PORT = "3773";
          process.env.GROK_TEST_INHERITED = "kept";
          return previous;
        }),
        (previous) =>
          Effect.sync(() => {
            for (const [name, value] of Object.entries(previous)) {
              if (value === undefined) delete process.env[name];
              else process.env[name] = value;
            }
          }),
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const output = `${directory}/environment.json`;
      const environment = yield* mergeProviderInstanceEnvironment([
        { name: "XAI_API_KEY", value: "configured", sensitive: false },
      ]);
      // The child records its environment and exits, so initialize fails once it has run.
      const runtime = yield* AcpSessionRuntime.make({
        spawn: {
          ...buildGrokAcpSpawnInput({ binaryPath: process.execPath }, directory, environment),
          args: [
            "-e",
            "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.env))",
            output,
          ],
        },
        cwd: directory,
        clientInfo: { name: "t3-test", version: "0.0.0" },
        authMethodId: "test",
      });
      yield* Effect.exit(runtime.initialize());

      const childEnvironment: NodeJS.ProcessEnv = JSON.parse(
        yield* fileSystem.readFileString(output),
      );
      expect(childEnvironment.T3CODE_PORT).toBeUndefined();
      expect(childEnvironment.PATH).toBe(process.env.PATH);
      expect(childEnvironment.GROK_TEST_INHERITED).toBe("kept");
      expect(childEnvironment.XAI_API_KEY).toBe("configured");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("passes additional instructions through Grok's rules option", () => {
    const spawn = buildGrokAcpSpawnInput(
      undefined,
      "/tmp/project",
      undefined,
      undefined,
      "Prefer focused tests.",
    );

    expect(spawn.args).toEqual(["--rules", "Prefer focused tests.", "agent", "stdio"]);
  });
});

describe("applyGrokAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<{
      modelId: string;
      meta?: { readonly [key: string]: unknown } | null;
    }> = [];
    const runtime = {
      setSessionModel: (modelId: string, meta?: { readonly [key: string]: unknown } | null) =>
        Effect.gen(function* () {
          modelCalls.push(meta === undefined ? { modelId } : { modelId, meta });
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-mock-alt",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-mock-alt" }]);
      expect(result).toBe("grok-mock-alt");
    }),
  );

  it.effect("applies reasoning effort through session/set_model metadata", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        currentReasoningEffort: "high",
        requestedModelId: "grok-4.6",
        requestedReasoningEffort: "xhigh",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-4.6", meta: { reasoningEffort: "xhigh" } }]);
      expect(result).toBe("grok-4.6");
    }),
  );

  it.effect("drops malformed effort metadata instead of sending it", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        currentReasoningEffort: "high",
        requestedModelId: "grok-4.6",
        requestedReasoningEffort: "not a token",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-4.6" }]);
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-build",
        requestedModelId: "grok-build",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("grok-build");
    }),
  );

  it.effect("keeps the session's current model when the product slug is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        requestedModelId: "grok-build",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("grok-4.6");
    }),
  );

  it.effect("applies reasoning to the current model when the product slug is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyGrokAcpModelSelection({
        runtime,
        currentModelId: "grok-4.6",
        currentReasoningEffort: "high",
        requestedModelId: "grok-build",
        requestedReasoningEffort: "xhigh",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([{ modelId: "grok-4.6", meta: { reasoningEffort: "xhigh" } }]);
      expect(result).toBe("grok-4.6");
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyGrokAcpModelSelection({
          runtime,
          currentModelId: "grok-build",
          requestedModelId: "grok-mock-alt",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
