import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import { EnvironmentLinkCompletionPersistence } from "./EnvironmentLinkCompletionPersistence.ts";

export const layer = Layer.effect(
  EnvironmentLinkCompletionPersistence,
  Effect.gen(function* () {
    const links = yield* EnvironmentLinks.EnvironmentLinks;
    const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
    return EnvironmentLinkCompletionPersistence.of({
      complete: Effect.fn("relay.environment_linker.complete")(function* (input) {
        yield* links.upsert(input);
        return yield* credentials.create({
          environmentId: input.proof.environmentId,
          environmentPublicKey: input.proof.environmentPublicKey,
        });
      }),
    });
  }),
);
