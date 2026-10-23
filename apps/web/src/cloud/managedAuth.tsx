import { useAtomValue } from "@effect/atom-react";
import {
  ManagedRelay,
  managedRelayAuthLoadAtom,
  managedRelaySessionAtom,
} from "@t3tools/client-runtime/relay";
import { reportAtomCommandResult, settleAsyncResult } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useEffect, useRef, type ReactNode } from "react";

import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { useAtomCommand } from "../state/use-atom-command";
import { restoreRelaySession } from "./relaySession";

/**
 * Restores the saved styal Link sign-in and clears relay environments from
 * this device when the signed-in account changes or signs out.
 */
export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  const session = useAtomValue(managedRelaySessionAtom);
  const loadState = useAtomValue(managedRelayAuthLoadAtom);
  const removeRelayEnvironments = useAtomCommand(environmentCatalog.removeRelayEnvironments, {
    reportFailure: false,
    reportDefect: false,
  });
  const observedAccountRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    void restoreRelaySession();
  }, []);

  const accountId = session?.accountId ?? null;
  useEffect(() => {
    if (loadState !== "loaded") return;
    const previousAccount = observedAccountRef.current;
    observedAccountRef.current = accountId;
    if (previousAccount === undefined || previousAccount === null) return;
    if (previousAccount === accountId) return;
    void (async () => {
      const results = await Promise.all([
        removeRelayEnvironments(),
        settleAsyncResult(() =>
          runtime.runPromiseExit(
            ManagedRelay.ManagedRelayClient.pipe(
              Effect.flatMap((client) => client.resetTokenCache),
            ),
          ),
        ),
      ]);
      for (const result of results) {
        reportAtomCommandResult(result, { label: "cloud account cleanup" });
      }
    })();
  }, [accountId, loadState, removeRelayEnvironments]);

  return <>{children}</>;
}
