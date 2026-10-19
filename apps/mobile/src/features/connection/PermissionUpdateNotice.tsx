import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { sessionHasLegacyPermissions } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import * as SecureStore from "expo-secure-store";
import { useEffect, useMemo, useRef, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { whenProtectedDataAvailable } from "../../lib/protectedData";
import { useEnvironments } from "../../state/environments";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

const storageKey = "t3code.permission-update.v1";
const dismissedThisLaunch = new Set<string>();
const shownThisLaunch = new Set<string>();
// Each connection is checked once, since a new connection may sign in with a
// different pairing or have gained a T3 Connect route.
const checkedConnections = new WeakSet<PreparedConnection>();

export function PermissionUpdateNotice() {
  const { environments } = useEnvironments();
  const [dismissed, setDismissed] = useState<ReadonlySet<string> | null>(null);
  // The connection each environment's notice is for, so a result shared with a
  // newer check cannot raise the notice for a connection it was not about.
  const [needsNotice, setNeedsNotice] = useState<ReadonlyMap<string, PreparedConnection>>(
    new Map(),
  );
  const showing = useRef(false);
  const retireLegacyPairing = useAtomCommand(environmentCatalog.retireLegacyPairing, {
    reportFailure: false,
  });
  const affected = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          environments.flatMap((environment) => {
            const { environmentId } = environment;
            const session = get(environmentSession.sessionStateAtom(environmentId));
            const prepared = Option.getOrNull(
              get(environmentSession.preparedConnectionValueAtom(environmentId)),
            );
            return session._tag === "Success" &&
              !session.waiting &&
              sessionHasLegacyPermissions(session.value) &&
              prepared !== null
              ? [{ environment, prepared }]
              : [];
          }),
        ),
      [environments],
    ),
  );

  // An old pairing is redundant when T3 Connect also reaches the environment,
  // so it is dropped instead of asking the user to pair again. This runs even
  // for environments whose notice was already acknowledged.
  useEffect(() => {
    for (const { environment, prepared } of affected) {
      const { environmentId } = environment;
      if (checkedConnections.has(prepared)) continue;
      checkedConnections.add(prepared);
      void retireLegacyPairing({ environmentId, checked: prepared }).then((result) => {
        const retired = result._tag === "Success" && result.value;
        setNeedsNotice((current) => {
          if (retired ? !current.has(environmentId) : current.get(environmentId) === prepared) {
            return current;
          }
          const next = new Map(current);
          if (retired) next.delete(environmentId);
          else next.set(environmentId, prepared);
          return next;
        });
      });
    }
  }, [affected, retireLegacyPairing]);

  useEffect(() => {
    let active = true;
    void whenProtectedDataAvailable()
      .then(() => SecureStore.getItemAsync(storageKey))
      .then((raw) => {
        const value: unknown = raw === null ? [] : JSON.parse(raw);
        if (active)
          setDismissed(
            new Set(
              Array.isArray(value)
                ? value.filter((id): id is string => typeof id === "string")
                : [],
            ),
          );
      })
      .catch(() => {
        if (active) setDismissed(new Set());
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (dismissed === null || showing.current) return;
    const environment = affected.find(
      ({ environment: { environmentId }, prepared }) =>
        needsNotice.get(environmentId) === prepared &&
        !dismissed.has(environmentId) &&
        !shownThisLaunch.has(environmentId),
    )?.environment;
    if (!environment) return;
    showing.current = true;
    shownThisLaunch.add(environment.environmentId);
    const dismiss = () => {
      dismissedThisLaunch.add(environment.environmentId);
      const next = new Set([...dismissed, ...dismissedThisLaunch]);
      showing.current = false;
      setDismissed(next);
      void SecureStore.setItemAsync(storageKey, JSON.stringify([...next])).catch(() => {});
    };
    Dialog.alert(
      `Permissions have changed for ${environment.label}`,
      "This connection still uses the old permissions, so some actions may no longer be available. Pair again using a new link with the permissions you need.",
      [{ text: "Got it", onPress: dismiss }],
      { cancelable: false },
    );
  }, [affected, dismissed, needsNotice]);
  return null;
}
