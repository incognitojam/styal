import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type {
  EnvironmentLinks,
  EnvironmentLinkUpsertPersistenceError,
} from "../environments/EnvironmentLinks.ts";
import type { EnvironmentCredentialCreatePersistenceError } from "../environments/EnvironmentCredentials.ts";

export class EnvironmentLinkCompletionPersistence extends Context.Service<
  EnvironmentLinkCompletionPersistence,
  {
    readonly complete: (
      input: Parameters<EnvironmentLinks["Service"]["upsert"]>[0],
    ) => Effect.Effect<
      string,
      EnvironmentLinkUpsertPersistenceError | EnvironmentCredentialCreatePersistenceError
    >;
  }
>()("t3code-relay/persistence/EnvironmentLinkCompletionPersistence") {}
