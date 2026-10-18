import { useAtomValue } from "@effect/atom-react";
import { connectionRouteId } from "@t3tools/client-runtime/connection";
import { sessionHasLegacyPermissions } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import * as SecureStore from "expo-secure-store";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";

import { environmentCatalog } from "../connection/catalog";
import { useEnvironments } from "../state/environments";
import { environmentSession } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

const storageKey = "t3code.permission-update.v1";
const dismissedThisLaunch = new Set<string>();
const shownThisLaunch = new Set<string>();
const checkedThisLaunch = new Set<string>();

export function PermissionUpdateNotice() {
  const { environments } = useEnvironments();
  const [dismissed, setDismissed] = useState<ReadonlySet<string> | null>(null);
  const [needsNotice, setNeedsNotice] = useState<ReadonlySet<string>>(new Set());
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
              ? [{ environment, activeRouteId: connectionRouteId(prepared.target) }]
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
    for (const { environment, activeRouteId } of affected) {
      const { environmentId } = environment;
      if (checkedThisLaunch.has(environmentId)) continue;
      checkedThisLaunch.add(environmentId);
      void retireLegacyPairing({ environmentId, activeRouteId }).then((result) => {
        if (result._tag === "Success" && result.value) return;
        setNeedsNotice((current) => new Set(current).add(environmentId));
      });
    }
  }, [affected, retireLegacyPairing]);

  useEffect(() => {
    let active = true;
    void SecureStore.getItemAsync(storageKey)
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
      ({ environment: { environmentId } }) =>
        needsNotice.has(environmentId) &&
        !dismissed.has(environmentId) &&
        !shownThisLaunch.has(environmentId),
    )?.environment;
    if (!environment) return;
    showing.current = true;
    shownThisLaunch.add(environment.environmentId);
    const dismiss = () => {
      dismissedThisLaunch.add(environment.environmentId);
      const next = new Set([...dismissed, ...dismissedThisLaunch]);
      // Keep notices serial when several environments have old grants.
      showing.current = false;
      setDismissed(next);
      void SecureStore.setItemAsync(storageKey, JSON.stringify([...next])).catch(() => {
        // Remember for this launch even if persistent storage is unavailable.
      });
    };
    Alert.alert(
      `Permissions have changed for ${environment.label}`,
      "This connection still uses the old permissions, so some actions may no longer be available. Pair again using a new link with the permissions you need.",
      [{ text: "Got it", onPress: dismiss }],
      { cancelable: false },
    );
  }, [affected, dismissed, needsNotice]);
  return null;
}
