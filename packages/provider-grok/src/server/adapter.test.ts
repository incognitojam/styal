// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { GrokSettings } from "../settings.ts";
import { makeGrokAcpAdapterFlavor, makeGrokAdapterV2 } from "./adapter.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  SecureRandom.layerWebCrypto,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const DEFAULT_GROK_SETTINGS = Schema.decodeSync(GrokSettings)({});
const instanceId = ProviderInstanceId.make("grok");
const select = (model: string, reasoningEffort?: string): ModelSelection => ({
  instanceId,
  model,
  ...(reasoningEffort === undefined
    ? {}
    : { options: [{ id: "reasoningEffort", value: reasoningEffort }] }),
});

const ModelRequest = Schema.Struct({
  method: Schema.String,
  params: Schema.Struct({
    modelId: Schema.optional(Schema.String),
    configId: Schema.optional(Schema.String),
    value: Schema.optional(Schema.String),
    _meta: Schema.optional(Schema.Struct({ reasoningEffort: Schema.optional(Schema.String) })),
  }),
});
const decodeModelRequest = Schema.decodeUnknownSync(Schema.fromJsonString(ModelRequest));

/** The model and effort writes Grok received, in wire order. */
function modelWrites(requestLogPath: string): ReadonlyArray<string> {
  return NodeFS.readFileSync(requestLogPath, "utf8")
    .split("\n")
    .filter(
      (line) =>
        line.includes('"session/set_model"') || line.includes('"session/set_config_option"'),
    )
    .map((line) => {
      const { method, params } = decodeModelRequest(line);
      return method === "session/set_model"
        ? `set_model ${params.modelId}${params._meta?.reasoningEffort ? ` effort=${params._meta.reasoningEffort}` : ""}`
        : `set_config_option ${params.configId}=${params.value}`;
    });
}

/**
 * Opens a Grok session on the first selection, then runs one turn per later
 * selection on the same live session. Returns the model and effort writes each
 * step sent.
 */
const writesPerSelection = (
  selections: ReadonlyArray<ModelSelection>,
  agentEnvironment: Readonly<Record<string, string>>,
  instructions?: {
    readonly steps: ReadonlyArray<string | undefined>;
    readonly launches: Array<string | undefined>;
  },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-grok-effort-" });
    const requestLogPath = path.join(directory, "requests.ndjson");
    yield* fileSystem.writeFileString(requestLogPath, "");
    const agentPath = yield* path.fromFileUrl(
      new URL("./testFixtures/grok-model-selection-agent.mjs", import.meta.url),
    );
    const adapter = yield* makeGrokAdapterV2({
      instanceId,
      settings: DEFAULT_GROK_SETTINGS,
      environment: {},
      hostPlatform: yield* HostProcess.Platform,
      selfInvocation: yield* resolveSelfInvocation(),
      makeRuntime: (runtimeInput) =>
        Effect.gen(function* () {
          instructions?.launches.push(runtimeInput.runtimePolicy.additionalInstructions);
          const context = yield* Layer.build(
            AcpSessionRuntime.layer({
              ...runtimeInput,
              spawn: {
                command: process.execPath,
                args: [agentPath],
                cwd: runtimeInput.cwd,
                env: { ...agentEnvironment, T3_ACP_REQUEST_LOG_PATH: requestLogPath },
              },
              authMethodId: "cached_token",
            }),
          );
          return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
            Effect.provide(context),
          );
        }),
    });
    const threadId = ThreadId.make("grok-effort-thread");
    const policyAt = (step: number) =>
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: directory,
        additionalInstructions: instructions?.steps[step],
      });
    const runtimePolicy = policyAt(0);
    const [first, ...rest] = selections;
    if (first === undefined) return [];
    const writes: Array<ReadonlyArray<string>> = [];
    const step = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const before = modelWrites(requestLogPath).length;
        const result = yield* effect;
        writes.push(modelWrites(requestLogPath).slice(before));
        return result;
      });
    const runtime = yield* step(
      adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("grok-effort-session"),
        modelSelection: first,
        runtimePolicy,
      }),
    );
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: first,
      runtimePolicy,
    });
    const now = yield* DateTime.now;
    for (const [index, modelSelection] of rest.entries()) {
      const ordinal = index + 1;
      const suffix = `${threadId}:${ordinal}`;
      yield* step(
        runtime.startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("grok-effort-project"),
            title: "Grok effort",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make(`run:${suffix}`),
          runOrdinal: ordinal,
          providerTurnOrdinal: ordinal,
          attemptId: RunAttemptId.make(`attempt:${suffix}`),
          rootNodeId: NodeId.make(`node:${suffix}`),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make(`message:${suffix}`),
            text: "hello",
            attachments: [],
          },
          modelSelection,
          runtimePolicy: policyAt(ordinal),
        }),
      );
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
    }
    return writes;
  }).pipe(Effect.scoped, Effect.provide(layerTest));

it.live("captures bundled skills before the Grok adapter leaves its host context", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const host = yield* ProviderHost.ProviderHost;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "styal-grok-skills-" });
    const log = path.join(directory, "requests.ndjson");
    yield* fs.writeFileString(log, "");
    const agentPath = yield* path.fromFileUrl(
      new URL("./testFixtures/grok-model-selection-agent.mjs", import.meta.url),
    );
    const launches: string[][] = [];
    const adapter = yield* makeGrokAdapterV2({
      instanceId,
      settings: { ...DEFAULT_GROK_SETTINGS, binaryPath: process.execPath },
      environment: {},
      hostPlatform: yield* HostProcess.Platform,
      selfInvocation: yield* resolveSelfInvocation(),
    }).pipe(
      Effect.provideService(ProviderHost.ProviderHost, {
        ...host,
        paths: { ...host.paths, skillDirectory: "/synthetic/styal" },
      }),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command))
            return Effect.die("Expected a simple Grok launch");
          launches.push(command.args.map(String));
          return spawner.spawn(
            ChildProcess.make(process.execPath, [agentPath], {
              ...command.options,
              env: { ...command.options.env, T3_ACP_REQUEST_LOG_PATH: log },
            }),
          );
        }),
      ),
    );
    const modelSelection = select("grok-build");
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: directory,
    });
    const runtime = yield* adapter.openSession({
      threadId: ThreadId.make("grok-skills"),
      providerSessionId: ProviderSessionId.make("grok-skills"),
      modelSelection,
      runtimePolicy,
    });
    yield* runtime.ensureThread({
      threadId: ThreadId.make("grok-skills"),
      modelSelection,
      runtimePolicy,
    });
    assert.deepEqual(
      launches.map((args) => args.slice(args.indexOf("--plugin-dir"))),
      [["--plugin-dir", "/synthetic/styal", "agent", "--always-approve", "stdio"]],
    );
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

describe("Grok reasoning effort", () => {
  // Grok's session starts at xhigh on grok-4.6. grok-4.6-fast offers only
  // high and low, and resets to high when a switch carries no effort.
  const selections = [
    select("grok-4.6", "low"),
    select("grok-4.6", "high"),
    select("grok-4.6"),
    select("grok-4.6", "high"),
    select("grok-4.6-fast", "xhigh"),
    select("grok-4.6", "low"),
  ];

  it.live("protocol 1 carries the selected effort on session/set_model", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* writesPerSelection(selections, { T3_GROK_MOCK_PROTOCOL: "1" }), [
        ["set_model grok-4.6 effort=low"],
        ["set_model grok-4.6 effort=high"],
        [],
        ["set_model grok-4.6 effort=high"],
        ["set_model grok-4.6-fast"],
        ["set_model grok-4.6 effort=low"],
      ]);
    }),
  );

  it.live("newer protocols write the session's own reasoning_effort option", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* writesPerSelection(selections, { T3_GROK_MOCK_PROTOCOL: "2" }), [
        ["set_config_option reasoning_effort=low"],
        ["set_config_option reasoning_effort=high"],
        [],
        [],
        ["set_config_option model=grok-4.6-fast"],
        ["set_config_option model=grok-4.6", "set_config_option reasoning_effort=low"],
      ]);
    }),
  );

  it.live("an effort Grok refuses keeps the model switch and opens the session", () =>
    Effect.gen(function* () {
      const refused = [select("grok-4.6-fast", "low")];
      assert.deepEqual(
        yield* writesPerSelection(refused, {
          T3_GROK_MOCK_PROTOCOL: "1",
          T3_GROK_MOCK_REJECT_EFFORT: "low",
        }),
        [["set_model grok-4.6-fast effort=low", "set_model grok-4.6-fast"]],
      );
      assert.deepEqual(
        yield* writesPerSelection(refused, {
          T3_GROK_MOCK_PROTOCOL: "2",
          T3_GROK_MOCK_REJECT_EFFORT: "low",
        }),
        [["set_config_option model=grok-4.6-fast", "set_config_option reasoning_effort=low"]],
      );
    }),
  );
});

it.effect("a steer reaches Grok as an interjection that carries its images", () =>
  Effect.gen(function* () {
    const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
    let reply: unknown = { result: { status: "queued" } };
    const runtime = {
      request: (method: string, params: unknown) => {
        requests.push({ method, params });
        return Effect.succeed(reply);
      },
    } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];
    const steering = makeGrokAcpAdapterFlavor(
      { makeRuntime: () => Effect.never } as unknown as Parameters<
        typeof makeGrokAcpAdapterFlavor
      >[0],
      "/home/ada",
    ).steering!;
    const image = { type: "image", data: "aGk=", mimeType: "image/png" } as const;

    assert.isUndefined(yield* steering.send(runtime, "session-1", "Look at this", [image]));
    yield* steering.send(runtime, "session-1", "Text only", []);
    assert.deepEqual(requests, [
      {
        method: "_x.ai/interject",
        params: { sessionId: "session-1", text: "Look at this", content: [image] },
      },
      { method: "_x.ai/interject", params: { sessionId: "session-1", text: "Text only" } },
    ]);

    reply = { result: { status: "rejected" } };
    const refused = yield* steering.send(runtime, "session-1", "Late", []).pipe(Effect.flip);
    assert.strictEqual(refused._tag, "AcpRequestError");
  }),
);

describe("Grok project instructions", () => {
  it.live("relaunches only when the project instructions change or clear", () =>
    Effect.gen(function* () {
      const launches: Array<string | undefined> = [];
      yield* writesPerSelection(
        [
          select("grok-4.6"),
          select("grok-4.6"),
          select("grok-4.6"),
          select("grok-4.6"),
          select("grok-4.6"),
        ],
        { T3_GROK_MOCK_PROTOCOL: "2" },
        {
          steps: ["Project rules", "Project rules", "Updated rules", "Updated rules", undefined],
          launches,
        },
      );
      assert.deepEqual(launches, ["Project rules", "Updated rules", undefined]);
    }),
  );
});
