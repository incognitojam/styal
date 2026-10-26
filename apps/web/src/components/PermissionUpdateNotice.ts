import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { sessionHasLegacyPermissions, type EnvironmentId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSummaries } from "../state/presentation";
import { environmentSession, readPreparedConnection } from "../state/session";
import { toastManager } from "./ui/toast";

interface LegacyPermissionEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: PreparedConnection;
}

/** Environments whose settled session over a prepared connection still carries pre-scope permissions. */
const legacyPermissionEnvironmentsAtom = Atom.make((get) =>
  get(environmentSummaries.identitiesAtom).flatMap(
    ({ environmentId, label }): Array<LegacyPermissionEnvironment> => {
      const session = get(environmentSession.sessionStateAtom(environmentId));
      if (
        session._tag !== "Success" ||
        session.waiting ||
        !sessionHasLegacyPermissions(session.value)
      )
        return [];
      const prepared = get(environmentSession.preparedConnectionValueAtom(environmentId));
      return Option.isSome(prepared) ? [{ environmentId, label, connection: prepared.value }] : [];
    },
  ),
).pipe(Atom.withLabel("web-legacy-permission-environments"));

const dismissalKey = (environmentId: EnvironmentId) =>
  `t3code:permission-update:v1:${environmentId}`;

function showPermissionNotice(
  router: AnyRouter,
  { environmentId, label }: { readonly environmentId: EnvironmentId; readonly label: string },
  isOpen: () => boolean,
) {
  const key = dismissalKey(environmentId);
  try {
    if (getLocalStorageItem(key, Schema.Boolean)) return undefined;
  } catch {
    // An unavailable store must not prevent the notice.
  }
  const persistDismissal = () => {
    try {
      setLocalStorageItem(key, true, Schema.Boolean);
    } catch {
      // The in-memory marker still prevents repeats during this launch.
    }
  };
  const dismiss = () => {
    persistDismissal();
    toastManager.close(id);
  };
  const id = toastManager.add({
    title: `Permissions have changed for ${label}`,
    description:
      "This connection still uses the old permissions, so some actions may no longer be available. Pair again using a new link with the permissions you need.",
    timeout: 0,
    // Closing it after the pairing was dropped is not the user's dismissal.
    onClose: () => {
      if (isOpen()) persistDismissal();
    },
    actionProps: {
      children: "Open Connections",
      onClick: () => {
        dismiss();
        void router.navigate({ to: "/settings/connections" });
      },
    },
    data: {
      actionLayout: "stacked-end",
      secondaryActionProps: { children: "Dismiss", onClick: dismiss },
      secondaryActionVariant: "ghost",
    },
  });
  return id;
}

/**
 * Drops an old pairing when styal Link also reaches the environment, and otherwise asks once per
 * environment per launch, until dismissed, to re-pair a connection that predates scoped permissions.
 * Each new connection is checked again, since it may sign in with a different pairing or have
 * gained a styal Link route.
 */
export function startPermissionUpdateNotices(router: AnyRouter): () => void {
  const checked = new WeakSet<PreparedConnection>();
  const shown = new Set<EnvironmentId>();
  const openNotices = new Map<EnvironmentId, string>();
  const check = ({ environmentId, label, connection }: LegacyPermissionEnvironment) => {
    checked.add(connection);
    void runAtomCommand(
      appAtomRegistry,
      environmentCatalog.retireLegacyPairing,
      { environmentId, checked: connection },
      { reportFailure: false },
    ).then((result) => {
      if (result._tag === "Success" && result.value) {
        const notice = openNotices.get(environmentId);
        openNotices.delete(environmentId);
        if (notice !== undefined) toastManager.close(notice);
        return;
      }
      // Checks queued together share the newest one's result, which says
      // nothing about an older connection.
      if (readPreparedConnection(environmentId) !== connection || shown.has(environmentId)) return;
      shown.add(environmentId);
      const notice = showPermissionNotice(router, { environmentId, label }, () =>
        openNotices.has(environmentId),
      );
      if (notice !== undefined) openNotices.set(environmentId, notice);
    });
  };
  return appAtomRegistry.subscribe(
    legacyPermissionEnvironmentsAtom,
    (environments) => {
      for (const environment of environments) {
        if (!checked.has(environment.connection)) check(environment);
      }
    },
    { immediate: true },
  );
}
