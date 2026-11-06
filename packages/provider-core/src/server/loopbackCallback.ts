// @effect-diagnostics nodeBuiltinImport:off - node:http sends the one-shot loopback callback with no proxy, redirect handling, or response logging.
import * as NodeHttp from "node:http";

import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** Replays a sign-in redirect the user pasted to the listener waiting on this machine. */
export const forwardLoopbackCallback = (
  instanceId: ProviderInstanceId,
  callback: URL,
): Effect.Effect<void, ProviderSetupError> =>
  Effect.callback<void, ProviderSetupError>((resume) => {
    const failed = () =>
      new ProviderSetupError({
        instanceId,
        operation: "complete",
        detail: "Could not deliver the sign-in response. Start sign-in again.",
      });
    let response: NodeHttp.IncomingMessage | undefined;
    const request = NodeHttp.request(
      {
        protocol: "http:",
        hostname: callback.hostname,
        port: callback.port,
        path: `${callback.pathname}${callback.search}`,
        method: "GET",
        agent: false,
      },
      (incoming) => {
        response = incoming;
        incoming.once("error", () => resume(Effect.fail(failed())));
        incoming.once("end", () => {
          const status = incoming.statusCode ?? 0;
          resume(status >= 200 && status < 300 ? Effect.void : Effect.fail(failed()));
        });
        incoming.resume();
      },
    );
    request.once("error", () => resume(Effect.fail(failed())));
    request.end();
    return Effect.sync(() => {
      request.destroy();
      response?.destroy();
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () =>
        Effect.fail(
          new ProviderSetupError({
            instanceId,
            operation: "complete",
            detail: "The sign-in response timed out. Start sign-in again.",
          }),
        ),
    }),
  );
