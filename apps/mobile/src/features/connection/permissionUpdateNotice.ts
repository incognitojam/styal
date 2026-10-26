import * as Dialog from "../../components/ui/Dialog";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { environmentCatalog } from "../../connection/catalog";
import { sessionHasLegacyPermissions } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as SecureStore from "expo-secure-store";

import { whenProtectedDataAvailable } from "../../lib/protectedData";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironmentPresentation } from "../../state/environments";
import { environmentPresentations } from "../../state/presentation";
import { environmentSession } from "../../state/session";

const storageKey = "t3code.permission-update.v1";

const legacyPermissionEnvironmentsAtom = Atom.make((get) =>
  [...get(environmentPresentations.presentationsAtom).entries()].flatMap(
    ([environmentId, presentation]) => {
      const session = get(environmentSession.sessionStateAtom(environmentId));
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      return prepared !== null &&
        session._tag === "Success" &&
        !session.waiting &&
        sessionHasLegacyPermissions(session.value)
        ? [{ environment: projectEnvironmentPresentation(environmentId, presentation), prepared }]
        : [];
    },
  ),
).pipe(Atom.withLabel("mobile:legacy-permission-environments"));

async function loadDismissedEnvironmentIds(): Promise<Set<string>> {
  try {
    await whenProtectedDataAvailable();
    const raw = await SecureStore.getItemAsync(storageKey);
    const value: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(
      Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}

/**
 * Tells the user, once per environment, that a paired session still carries
 * the legacy permission set. App-lifetime; presents one dialog at a time.
 */
export function installPermissionUpdateNotice(): () => void {
  let dismissed: Set<string> | null = null;
  const shownThisLaunch = new Set<string>();
  let showing = false;
  let disposed = false;

  const checkedConnections = new WeakSet<PreparedConnection>();
  const needsNotice = new Map<string, PreparedConnection>();
  const presentNext = () => {
    if (disposed) return;
    const affected = appAtomRegistry.get(legacyPermissionEnvironmentsAtom);
    for (const { environment, prepared } of affected) {
      if (checkedConnections.has(prepared)) continue;
      checkedConnections.add(prepared);
      void runAtomCommand(
        appAtomRegistry,
        environmentCatalog.retireLegacyPairing,
        { environmentId: environment.environmentId, checked: prepared },
        { reportFailure: false },
      ).then((result) => {
        if (disposed) return;
        if (result._tag === "Success" && result.value)
          needsNotice.delete(environment.environmentId);
        else needsNotice.set(environment.environmentId, prepared);
        presentNext();
      });
    }
    if (disposed || dismissed === null || showing) return;
    const known = dismissed;
    const environment = affected.find(
      ({ environment: { environmentId }, prepared }) =>
        needsNotice.get(environmentId) === prepared &&
        !known.has(environmentId) &&
        !shownThisLaunch.has(environmentId),
    )?.environment;
    if (!environment) return;
    showing = true;
    shownThisLaunch.add(environment.environmentId);
    const dismiss = () => {
      known.add(environment.environmentId);
      showing = false;
      void SecureStore.setItemAsync(storageKey, JSON.stringify([...known])).catch(() => {});
      presentNext();
    };
    Dialog.alert(
      `Permissions have changed for ${environment.label}`,
      "This connection still uses the old permissions, so some actions may no longer be available. Pair again using a new link with the permissions you need.",
      [{ text: "Got it", onPress: dismiss }],
      { cancelable: false },
    );
  };

  const unsubscribe = appAtomRegistry.subscribe(legacyPermissionEnvironmentsAtom, presentNext, {
    immediate: true,
  });
  void loadDismissedEnvironmentIds().then((ids) => {
    dismissed = ids;
    presentNext();
  });
  return () => {
    disposed = true;
    unsubscribe();
  };
}
