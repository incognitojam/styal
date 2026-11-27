import { ManagedRelay } from "@t3tools/client-runtime/relay-session";
import {
  reportAtomCommandResult,
  runAtomCommand,
  settleAsyncResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { BrowserDpopError } from "./dpop";

// A failed route removal must prevent a replacement account from activating.
export const cleanUpRelayAccount = Effect.tryPromise({
  try: async () => {
    const [removal, tokenReset] = await Promise.all([
      runAtomCommand(appAtomRegistry, environmentCatalog.removeRelayEnvironments, undefined, {
        reportFailure: false,
        reportDefect: false,
      }),
      settleAsyncResult(() =>
        runtime.runPromiseExit(
          ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
        ),
      ),
    ]);
    reportAtomCommandResult(tokenReset, { label: "cloud account cleanup" });
    if (removal._tag !== "Success") throw squashAtomCommandFailure(removal);
  },
  catch: (cause) =>
    new BrowserDpopError({ message: "Could not clear the previous styal Link account.", cause }),
});
