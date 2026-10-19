import { useAtomValue } from "@effect/atom-react";
import {
  hardwareDevicesHeldBy,
  hardwareLeaseStateLabel,
} from "@t3tools/client-runtime/state/hardware";
import {
  type EnvironmentId,
  type HardwareDeviceState,
  type HardwareLeaseSummary,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CpuIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useServerConfigs } from "~/state/entities";
import { hardwareEnvironment, useHardwareState } from "~/state/hardware";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { reportHardwareResult } from "./reportHardwareResult";

/** The idle countdown only needs minute precision; nothing ticks for kept or working leases. */
const IDLE_TICK_MS = 30_000;

/**
 * Thread header chip for hardware this thread holds: the way out for a lease
 * that outlives its turns. Renders nothing, and does not subscribe, unless the
 * thread's project owns a hardware device on this environment.
 */
export function HardwareLeaseChips(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId | null;
}) {
  const devices = useServerConfigs().get(props.environmentId)?.settings.hardwareDevices;
  const projectOwnsHardware =
    props.projectId !== null &&
    (devices ?? []).some((device) => device.projectId === props.projectId);
  if (!projectOwnsHardware) return null;
  return <HeldHardwareChips environmentId={props.environmentId} threadId={props.threadId} />;
}

function HeldHardwareChips({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const { state } = useHardwareState(environmentId, { probeHealth: false });
  const held = hardwareDevicesHeldBy(state.devices, threadId);
  if (held.length === 0) return null;
  return (
    <>
      {held.map((device) =>
        device.lease ? (
          <HardwareLeaseChip
            key={device.id}
            environmentId={environmentId}
            device={device}
            lease={device.lease}
          />
        ) : null,
      )}
    </>
  );
}

/**
 * The lease state text. Keyed by the idle deadline, so a new deadline starts
 * a fresh clock; only an idle countdown ticks.
 */
function LeaseStateLabel({ lease }: { lease: HardwareLeaseSummary }) {
  const idle = !lease.keepUntilReleased && lease.idleExpiresAt !== null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!idle) return;
    const id = setInterval(() => setNowMs(Date.now()), IDLE_TICK_MS);
    return () => clearInterval(id);
  }, [idle]);
  return hardwareLeaseStateLabel(lease, nowMs);
}

function HardwareLeaseChip({
  environmentId,
  device,
  lease,
}: {
  environmentId: EnvironmentId;
  device: HardwareDeviceState;
  lease: HardwareLeaseSummary;
}) {
  const navigate = useNavigate();
  const canOperate = useAtomValue(hardwareEnvironment.control.permissionAtom(environmentId));
  const control = useAtomCommand(hardwareEnvironment.control, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const run = async (
    input: Parameters<typeof control>[0]["input"],
    failureTitle: string,
  ): Promise<void> => {
    setPending(true);
    try {
      reportHardwareResult(await control({ environmentId, input }), failureTitle);
    } finally {
      setPending(false);
    }
  };
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="outline" className="max-w-64 shrink-0" />}>
        <CpuIcon />
        <span className="truncate">
          Holding {device.name} ·{" "}
          <LeaseStateLabel key={`${lease.grantedAt}:${lease.idleExpiresAt}`} lease={lease} />
        </span>
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>{lease.purpose || device.name}</MenuGroupLabel>
          <MenuItem
            disabled={!canOperate || pending}
            onClick={() =>
              void run({ type: "revoke", deviceId: device.id }, `Could not release ${device.name}`)
            }
          >
            Release
          </MenuItem>
          <MenuCheckboxItem
            variant="switch"
            disabled={!canOperate || pending}
            checked={lease.keepUntilReleased}
            onCheckedChange={(checked) =>
              void run(
                { type: "set-keep", deviceId: device.id, keepUntilReleased: Boolean(checked) },
                `Could not change ${device.name}`,
              )
            }
          >
            Keep until I release
          </MenuCheckboxItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={() => void navigate({ to: "/settings/hardware" })}>
          Hardware settings
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
