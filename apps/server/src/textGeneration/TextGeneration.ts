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

import * as ServerSettings from "../serverSettings.ts";
import type { ModelSelection, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { TextGenerationError } from "@t3tools/contracts";

import { resolveTextGenerationModelSelection } from "@t3tools/shared/serverSettings";
import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";
import { isTextGenerationRateLimitError } from "@t3tools/provider-core/server/textGenerationUtils";
import * as TextGenerators from "./TextGenerators.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

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
  TranscriptionPostProcessingInput,
  TranscriptionPostProcessingResult,
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
  | "checkMentionedTimes"
  | "generateTranscriptionPostProcessing";

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
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const installationGate = yield* ProviderInstallationGate.ProviderInstallationGate;
  const textGenerators = yield* TextGenerators.TextGenerators;
  const generateWithRetry = Effect.fn("TextGeneration.generateWithRetry")(function* <A>(
    operation: TextGenerationOp,
    requested: ModelSelection,
    projectId: ProjectId | null | undefined,
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
    if (projectId) {
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
      for (const provider of providers) {
        if (
          provider.instanceId !== requested.instanceId &&
          !resolveProjectProviderInstanceEnabled(settings, projectId, provider.instanceId)
        ) {
          attempted.add(provider.instanceId);
        }
      }
    }
    let modelSelection = resolveTextGenerationModelSelection(
      { textGenerationModelSelection: requested },
      providers,
      attempted,
    );
    while (true) {
      const result = yield* installationGate
        .execute(
          modelSelection.instanceId,
          resolveInstance(registry, operation, modelSelection.instanceId).pipe(
            Effect.flatMap((textGeneration) => run(textGeneration, modelSelection)),
          ),
        )
        .pipe(Effect.result);
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
  const generate = Effect.fn("TextGeneration.generate")(function* <A>(
    operation: TextGenerationOp,
    selection: ModelSelection,
    projectId: ProjectId | null | undefined,
    invoke: (
      service: ProviderTextGeneration,
      modelSelection: ModelSelection,
    ) => Effect.Effect<A, TextGenerationError>,
  ) {
    const textGenerator = yield* textGenerators.runner(selection.instanceId);
    // A review guide reaches a text generator only through a fallback; it needs an agent instead.
    const textGeneratorId = selection.instanceId;
    const textGeneratorCannotRun =
      textGenerator !== undefined && operation === "generateReviewGuide";
    if (textGenerator !== undefined && !textGeneratorCannotRun) {
      return yield* invoke(
        TextGenerationOperations.fromRunner("TextGenerator", textGenerator),
        selection,
      );
    }
    const snapshots = yield* registry.listInstances.pipe(
      Effect.flatMap((instances) =>
        Effect.forEach(instances, (instance) => instance.snapshot.getSnapshot),
      ),
    );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const selected = snapshots.find((provider) => provider.instanceId === selection.instanceId);
    // Only a failed probe counts: a pending one is also not installed yet.
    const unusable =
      textGeneratorCannotRun ||
      (selected?.enabled === true &&
        (!isProviderTextGenerationCapable(selected) ||
          selected.models.find((model) => model.slug === selection.model)
            ?.supportsTextGeneration === false ||
          (selected.status === "error" &&
            (!selected.installed || selected.auth.status === "unauthenticated"))));
    if (unusable || exhaustedUsageWindow(selected, now, selection.model)) {
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
      const excluded = snapshots
        .filter(
          (provider) =>
            provider.instanceId === selection.instanceId ||
            provider.enabled !== true ||
            !resolveProjectProviderInstanceEnabled(
              settings,
              projectId ?? null,
              provider.instanceId,
            ) ||
            !provider.installed ||
            provider.auth.status === "unauthenticated" ||
            !isProviderAvailable(provider) ||
            !isProviderTextGenerationCapable(provider) ||
            (operation === "generateReviewGuide" && !INVESTIGATING_DRIVERS.has(provider.driver)),
        )
        .map((provider) => provider.instanceId);
      // A text generator has no snapshot, so it is excluded by id.
      selection = resolveTextGenerationModelSelection(
        { textGenerationModelSelection: selection },
        snapshots,
        new Set([selection.instanceId, ...excluded]),
        {
          providerInstances: settings.providerInstances,
          defaultModelSelection: settings.defaultModelSelection,
          isModelUsable: (provider, model) =>
            provider.models.find((entry) => entry.slug === model)?.supportsTextGeneration !==
              false && !exhaustedUsageWindow(provider, now, model),
        },
      );
    }
    if (textGeneratorCannotRun && selection.instanceId === textGeneratorId) {
      return yield* new TextGenerationError({
        operation,
        detail:
          "Review guides need a coding agent that can read the checkout. None is ready. Pick Codex or Claude as the review guide model in Settings → Source control.",
      });
    }
    return yield* generateWithRetry(operation, selection, projectId, invoke);
  });
  return TextGeneration.of({
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return generate(
        "generateCommitMessage",
        input.modelSelection,
        input.projectId,
        (textGeneration, modelSelection) =>
          textGeneration.generateCommitMessage({ ...input, modelSelection }),
      );
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return generate(
        "generatePrContent",
        input.modelSelection,
        input.projectId,
        (textGeneration, modelSelection) =>
          textGeneration.generatePrContent({ ...input, modelSelection }),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return generate(
        "generateBranchName",
        input.modelSelection,
        input.projectId,
        (textGeneration, modelSelection) =>
          textGeneration.generateBranchName({ ...input, modelSelection }),
      );
    }),
    generateReviewGuide: Effect.fn("TextGeneration.generateReviewGuide")(function (input) {
      return generate(
        "generateReviewGuide",
        input.modelSelection,
        input.projectId,
        (textGeneration, modelSelection) =>
          textGeneration.generateReviewGuide({ ...input, modelSelection }),
      );
    }),
    generateTranscriptionPostProcessing: Effect.fn(
      "TextGeneration.generateTranscriptionPostProcessing",
    )(function (input) {
      return generate(
        "generateTranscriptionPostProcessing",
        input.modelSelection,
        null,
        (service, modelSelection) =>
          service.generateTranscriptionPostProcessing({ ...input, modelSelection }),
      );
    }),
    checkMentionedTimes: Effect.fn("TextGeneration.checkMentionedTimes")(function (input) {
      return generate(
        "checkMentionedTimes",
        input.modelSelection,
        null,
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
        input.projectId,
        (textGeneration, modelSelection) =>
          textGeneration.generateThreadTitle({ ...input, modelSelection, linkedContext }),
      );
    }),
  });
});

export const layer = Layer.effect(TextGeneration, make).pipe(
  Layer.provideMerge(TextGenerators.layer),
);
