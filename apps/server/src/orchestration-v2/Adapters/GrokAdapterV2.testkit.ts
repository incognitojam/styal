import * as NodeServices from "@effect/platform-node/NodeServices";
import { GrokSettings } from "@t3tools/provider-grok/settings";
import * as Effect from "effect/Effect";
import type * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { GROK_ACP_CANCEL_META, GROK_ACP_INITIALIZE_META } from "@t3tools/provider-grok/testing";
import { makeXAiPromptCompletionRuntime } from "@t3tools/provider-grok/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import {
  type AcpReplayTranscript,
  AcpReplayTranscriptDecodeError,
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import {
  GROK_DEFAULT_INSTANCE_ID,
  GROK_PROVIDER,
  makeGrokAdapterV2,
} from "@t3tools/provider-grok/testing";

const DEFAULT_GROK_SETTINGS = Schema.decodeUnknownSync(GrokSettings)({});

function layerGrokProviderAdapterRegistryReplay(
  transcript: AcpReplayTranscript,
  options: { readonly replayGate?: ProviderReplayGate } = {},
) {
  const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

  return ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const hostPlatform = yield* HostProcess.Platform;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const replayGate = options.replayGate;
      const fastWake = transcript.scenario === "grok_background_bash_fast_wake";
      let wakeDrained = !fastWake;
      let pendingFinish: Duration.Input | undefined;
      const recordFinishArmed = (debounce: Duration.Input) => {
        if (wakeDrained) replayGate?.recordFinishArmed(debounce);
        else pendingFinish = debounce;
      };
      const settleRootBeforeCompletion =
        transcript.scenario === "grok_monitor" ||
        transcript.scenario === "grok_background_subagent" ||
        transcript.scenario === "grok_background_bash" ||
        transcript.scenario === "grok_background_bash_fast_wake";
      const inboundEntries = transcript.entries.filter((entry) => entry.type === "emit_inbound");
      const rootReplyIndex = inboundEntries.findIndex(
        (entry) =>
          Predicate.isObject(entry.frame) &&
          entry.frame.kind === "response" &&
          entry.frame.method === "session/prompt",
      );
      let inboundCursor = 0;
      let releaseRootPrompt = () => {};
      const rootPromptSettled = new Promise<void>((resolve) => {
        releaseRootPrompt = resolve;
      });
      const runtimeReplayGate: ProviderReplayGate | undefined =
        replayGate === undefined
          ? undefined
          : {
              ...replayGate,
              beforeEmit: async (label, signal) => {
                // The recorded background tasks outlive root RPC completion.
                // Preserve that ordering through the actual adapter receipt
                // while still replaying later fast wake frames ungated.
                if (
                  settleRootBeforeCompletion &&
                  inboundCursor++ === rootReplyIndex + 1 &&
                  !signal?.aborted
                ) {
                  await new Promise<void>((resolve) => {
                    const stopped = () => resolve();
                    signal?.addEventListener("abort", stopped, { once: true });
                    void rootPromptSettled.then(() => {
                      signal?.removeEventListener("abort", stopped);
                      resolve();
                    });
                  });
                }
                await replayGate.beforeEmit(label, signal);
              },
            };
      const replayDir = yield* fileSystem
        .makeTempDirectory({
          prefix: `t3-orchestration-v2-grok-replay-${transcript.scenario}-`,
        })
        .pipe(Effect.orDie);
      const statusPath = path.join(replayDir, "status.json");
      const scriptPath = yield* path
        .fromFileUrl(new URL("../../../scripts/acp-replay-agent.ts", import.meta.url))
        .pipe(Effect.orDie);
      const adapter = yield* makeGrokAdapterV2({
        instanceId: GROK_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_GROK_SETTINGS,
        environment: {},
        hostPlatform,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (runtimeInput) =>
          makeAcpReplayRuntime({
            transcript,
            statusPath,
            scriptPath,
            childProcessSpawner,
            fileSystem,
            ...(runtimeReplayGate === undefined ? {} : { replayGate: runtimeReplayGate }),
            cancelMeta: GROK_ACP_CANCEL_META,
            initializeMeta: GROK_ACP_INITIALIZE_META,
          })(runtimeInput).pipe(
            Effect.flatMap(makeXAiPromptCompletionRuntime),
            Effect.map((runtime) => {
              if (!fastWake) return runtime;
              const observed: typeof runtime = {
                ...runtime,
                handleExtNotification: (method, payload, handler) =>
                  runtime.handleExtNotification(method, payload, (notification) =>
                    handler(notification).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          if (!Predicate.isObject(notification)) return;
                          const update = notification.update;
                          if (!Predicate.isObject(update)) return;
                          const promptId = update.prompt_id ?? update.promptId;
                          if (
                            update.sessionUpdate !== "turn_completed" ||
                            typeof promptId !== "string" ||
                            !promptId.startsWith("task-completed-")
                          )
                            return;
                          // The recorded wake arrives inside the root's 3s debounce, so no quiet
                          // gap is simulated while frames still cross child IO. This receipt
                          // follows the adapter callback, so the whole wake has completed.
                          wakeDrained = true;
                          if (pendingFinish !== undefined) {
                            replayGate?.recordFinishArmed(pendingFinish);
                            pendingFinish = undefined;
                          }
                        }),
                      ),
                    ),
                  ),
              };
              return observed;
            }),
          ),
        continuationRequests,
        assertComplete: makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript),
        ...(replayGate === undefined
          ? {}
          : {
              testHooks: {
                afterPromptSettledWithBackgroundWork: () => Effect.sync(releaseRootPrompt),
                onDeferredFinalizeScheduled: (debounce) =>
                  Effect.sync(() => recordFinishArmed(debounce)),
              },
            }),
      });
      return [adapter];
    }),
  ).pipe(
    Layer.provide(Layer.mergeAll(layerHost, NodeServices.layer, IdAllocator.layer)),
    // Held inbound lines must not outlive the scenario and wedge teardown.
    Layer.merge(
      Layer.effectDiscard(
        Effect.addFinalizer(() => Effect.sync(() => options.replayGate?.releaseAll())),
      ),
    ),
  );
}

export const GrokOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  AcpReplayTranscript,
  AcpReplayTranscriptDecodeError
> = {
  driver: GROK_PROVIDER,
  decodeTranscript: (transcript) => decodeAcpReplayTranscript(transcript, GROK_PROVIDER),
  makeProviderAdapterRegistryLayer: layerGrokProviderAdapterRegistryReplay,
};
