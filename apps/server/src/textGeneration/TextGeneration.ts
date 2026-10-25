import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
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
  | "generateReviewGuide";

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

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const generate = Effect.fn("TextGeneration.generate")(function* <A>(
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
  return TextGeneration.of({
    generateCommitMessage: (input) =>
      generate("generateCommitMessage", input.modelSelection, (textGeneration, modelSelection) =>
        textGeneration.generateCommitMessage({ ...input, modelSelection }),
      ),
    generatePrContent: (input) =>
      generate("generatePrContent", input.modelSelection, (textGeneration, modelSelection) =>
        textGeneration.generatePrContent({ ...input, modelSelection }),
      ),
    generateBranchName: (input) =>
      generate("generateBranchName", input.modelSelection, (textGeneration, modelSelection) =>
        textGeneration.generateBranchName({ ...input, modelSelection }),
      ),
    generateReviewGuide: (input) =>
      generate("generateReviewGuide", input.modelSelection, (textGeneration, modelSelection) =>
        textGeneration.generateReviewGuide({ ...input, modelSelection }),
      ),
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
