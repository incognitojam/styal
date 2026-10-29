import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as DateTime from "effect/DateTime";
import {
  isProviderAvailable,
  isProviderTextGenerationCapable,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
import { defaultTextGenerationModel } from "@t3tools/shared/serverSettings";
import * as ServerSettings from "../serverSettings.ts";
import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { TextGenerationError } from "@t3tools/contracts";

import { resolveTextGenerationModelSelection } from "@t3tools/shared/serverSettings";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";
import { isTextGenerationRateLimitError } from "@t3tools/provider-core/server/textGenerationUtils";

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";

export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "@styal/cli/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateReviewGuide"
  | "checkMentionedTimes";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

// Review guides investigate the checkout read-only; the other drivers reject that request.
const INVESTIGATING_DRIVERS = new Set(["codex", "claudeAgent"]);

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const generateWithRetry = Effect.fn("TextGeneration.generateWithRetry")(function* <A>(
    operation: TextGenerationOp,
    requested: ModelSelection,
    run: (
      textGeneration: TextGeneration["Service"],
      modelSelection: ModelSelection,
    ) => Effect.Effect<A, TextGenerationError>,
  ) {
    const instances = yield* registry.listInstances;
    const providers = [
      ...(yield* Effect.forEach(instances, (instance) => instance.snapshot.getSnapshot, {
        concurrency: "unbounded",
      })),
      ...(yield* registry.listUnavailable),
    ];
    const attempted = new Set<string>();
    let modelSelection = resolveTextGenerationModelSelection(
      { textGenerationModelSelection: requested },
      providers,
    );
    while (true) {
      const result = yield* resolveInstance(registry, operation, modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => run(textGeneration, modelSelection)),
        Effect.result,
      );
      if (Result.isSuccess(result)) return result.success;
      attempted.add(modelSelection.instanceId);
      if (!isTextGenerationRateLimitError(result.failure)) return yield* result.failure;
      const next = resolveTextGenerationModelSelection(
        { textGenerationModelSelection: requested },
        providers,
        attempted,
      );
      if (next.instanceId === requested.instanceId) {
        return yield* result.failure;
      }
      yield* Effect.logDebug("Text generation rate limit: trying another provider", {
        operation,
        from: modelSelection.instanceId,
        to: next.instanceId,
      });
      modelSelection = next;
    }
  });
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const generate = Effect.fn("TextGeneration.generate")(function* <A>(
    operation: TextGenerationOp,
    selection: ModelSelection,
    invoke: (
      service: ProviderTextGeneration,
      modelSelection: ModelSelection,
    ) => Effect.Effect<A, TextGenerationError>,
  ) {
    const snapshots = yield* registry.listInstances.pipe(
      Effect.flatMap((instances) =>
        Effect.forEach(instances, (instance) => instance.snapshot.getSnapshot),
      ),
    );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const limited = exhaustedUsageWindow(
      snapshots.find((provider) => provider.instanceId === selection.instanceId),
      now,
      selection.model,
    );
    if (limited) {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Could not read fallback model settings.",
              cause,
            }),
        ),
      );
      const unusable = snapshots
        .filter(
          (provider) =>
            provider.instanceId === selection.instanceId ||
            provider.enabled !== true ||
            !resolveProjectProviderInstanceEnabled(settings, null, provider.instanceId) ||
            !provider.installed ||
            provider.auth.status === "unauthenticated" ||
            !isProviderAvailable(provider) ||
            !isProviderTextGenerationCapable(provider) ||
            (operation === "generateReviewGuide" && !INVESTIGATING_DRIVERS.has(provider.driver)) ||
            exhaustedUsageWindow(provider, now, defaultTextGenerationModel(provider.driver)),
        )
        .map((provider) => provider.instanceId);
      selection = resolveTextGenerationModelSelection(
        { textGenerationModelSelection: selection },
        snapshots,
        new Set(unusable),
      );
    }
    return yield* generateWithRetry(operation, selection, invoke);
  });
  return TextGeneration.of({
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return generate(
        "generateCommitMessage",
        input.modelSelection,
        (textGeneration, modelSelection) =>
          textGeneration.generateCommitMessage({ ...input, modelSelection }),
      );
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return generate("generatePrContent", input.modelSelection, (textGeneration, modelSelection) =>
        textGeneration.generatePrContent({ ...input, modelSelection }),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return generate(
        "generateBranchName",
        input.modelSelection,
        (textGeneration, modelSelection) =>
          textGeneration.generateBranchName({ ...input, modelSelection }),
      );
    }),
    generateReviewGuide: Effect.fn("TextGeneration.generateReviewGuide")(function (input) {
      return generate(
        "generateReviewGuide",
        input.modelSelection,
        (textGeneration, modelSelection) =>
          textGeneration.generateReviewGuide({ ...input, modelSelection }),
      );
    }),
    checkMentionedTimes: Effect.fn("TextGeneration.checkMentionedTimes")(function (input) {
      return generate(
        "checkMentionedTimes",
        input.modelSelection,
        (textGeneration, modelSelection) =>
          textGeneration.checkMentionedTimes({ ...input, modelSelection }),
      );
    }),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function* (input) {
      const linkedContext =
        input.linkedContext ??
        (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
          Effect.provideService(
            SourceControlProviderRegistry.SourceControlProviderRegistry,
            sourceControl,
          ),
        ));
      return yield* generate(
        "generateThreadTitle",
        input.modelSelection,
        (textGeneration, modelSelection) =>
          textGeneration.generateThreadTitle({ ...input, modelSelection, linkedContext }),
      );
    }),
  });
});

export const layer = Layer.effect(TextGeneration, make);
