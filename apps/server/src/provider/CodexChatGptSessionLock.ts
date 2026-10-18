import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { withSecretStoreLock } from "../auth/SecretStoreLock.ts";

/** Keep rotating tokens and their active profile atomic across servers sharing a secret store. */
export const withChatGptSessionLock = <A, E, R>(
  directory: string | undefined,
  key: string,
  instanceId: ProviderInstanceId,
  task: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ProviderSetupError, R> =>
  withSecretStoreLock(directory, key, task).pipe(
    Effect.catchTags({
      SecretStoreLockError: () =>
        Effect.fail(
          new ProviderSetupError({
            instanceId,
            operation: "credential-lock",
            detail: "Could not lock the ChatGPT connection for an update. Try again.",
          }),
        ),
    }),
  );
