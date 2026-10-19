import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { sessionHasLegacyPermissions, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { environmentCatalog } from "../connection/catalog";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { useEnvironments } from "../state/environments";
import {
  environmentSession,
  readPreparedConnection,
  usePreparedConnection,
} from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { toastManager } from "./ui/toast";

// Each connection is checked once, since a new connection may sign in with a
// different pairing or have gained a T3 Connect route. The notice shows once
// per environment per launch, and an active toast survives remounts, including
// Strict Mode effect replay.
const checked = new WeakSet<PreparedConnection>();
const shown = new Set<EnvironmentId>();
const openNotices = new Map<EnvironmentId, string>();

function showPermissionNotice(input: {
  environmentId: EnvironmentId;
  label: string;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const { environmentId, label, navigate } = input;
  const key = `t3code:permission-update:v1:${environmentId}`;
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
    onClose: persistDismissal,
    actionProps: {
      children: "Open Connections",
      onClick: () => {
        dismiss();
        void navigate({ to: "/settings/connections" });
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

function EnvironmentPermissionNotice({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const session = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const prepared = usePreparedConnection(environmentId);
  const retireLegacyPairing = useAtomCommand(environmentCatalog.retireLegacyPairing, {
    reportFailure: false,
  });
  const navigate = useNavigate();
  useEffect(() => {
    if (
      session._tag !== "Success" ||
      session.waiting ||
      !sessionHasLegacyPermissions(session.value) ||
      prepared._tag === "None"
    )
      return;
    if (checked.has(prepared.value)) return;
    checked.add(prepared.value);
    // An old pairing is redundant when T3 Connect also reaches the environment,
    // so it is dropped instead of asking the user to pair again.
    const current = prepared.value;
    void retireLegacyPairing({ environmentId, checked: current }).then((result) => {
      if (result._tag === "Success" && result.value) {
        const notice = openNotices.get(environmentId);
        if (notice !== undefined) toastManager.close(notice);
        return;
      }
      // Checks queued together share the newest one's result, which says
      // nothing about an older connection.
      if (readPreparedConnection(environmentId) !== current || shown.has(environmentId)) return;
      shown.add(environmentId);
      const notice = showPermissionNotice({ environmentId, label, navigate });
      if (notice !== undefined) openNotices.set(environmentId, notice);
    });
  }, [environmentId, label, navigate, prepared, retireLegacyPairing, session]);

  return null;
}

export function PermissionUpdateNotice() {
  const { environments } = useEnvironments();
  return environments.map(({ environmentId, label }) => (
    <EnvironmentPermissionNotice key={environmentId} environmentId={environmentId} label={label} />
  ));
}
