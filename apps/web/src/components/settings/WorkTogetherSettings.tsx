import {
  LINK_DEFAULT_ACCESS,
  linkAccessLabel,
  machineAccessChoice,
  machineNames,
} from "@t3tools/client-runtime/link-request";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  planStopWorkingTogether,
  planWorkTogether,
  type WorkTogetherLine,
  type WorkTogetherMachine,
  type WorkTogetherIdentity,
  workTogetherLabels,
  workTogetherFailureMessage,
  workTogetherHasNarrowerAccess,
  workTogetherMissingShares,
  workTogetherNeedsAttention,
  workTogetherOutcome,
  workTogetherSharedDevices,
  workTogetherStatus,
} from "@t3tools/client-runtime/state/workTogether";
import {
  AuthAccessWriteScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type IncomingMachineAccess,
  type PeerLinkSummary,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { Tabs } from "@base-ui/react/tabs";
import * as DateTime from "effect/DateTime";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleIcon,
  ClockIcon,
  MinusIcon,
  PlusIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { reportForkClientUsage } from "~/forkClientUsage";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useDeviceState } from "../../state/device";
import { useEnvironments } from "../../state/environments";
import {
  peerLinkEnvironment,
  useLinkableMachines,
  usePeerLinkHosts,
  workTogether,
} from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Button } from "../ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { useDeviceSharingAddresses } from "./EnvironmentDeviceHostsSettings";
import {
  AddMachineAction,
  OtherMachineLinks,
  peerLinkHealthText,
} from "./LinkedEnvironmentsSettings";
import { SettingsGroup } from "./SettingsGroup";
import { MachineAccessSetting } from "./MachineAccessSetting";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type Environment = ReturnType<typeof useEnvironments>["environments"][number];
type NamedEnvironment = Environment & WorkTogetherIdentity;
type RunKind = "start" | "stop";

/**
 * One tab per machine, joined to a panel listing the machines it works with. Every pair stays
 * mounted so a run in progress survives switching tabs, and so each tab can show a problem.
 */
export function WorkTogetherSettings() {
  const { environments } = useEnvironments();
  const hosts = usePeerLinkHosts();
  const [chosenTab, setChosenTab] = useState<string | null>(null);
  const [attention, setAttention] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [showOthers, setShowOthers] = useState(false);
  const machines = workTogetherLabels(
    environments.filter(
      (environment) => environment.serverConfig?.environment.capabilities.peerLinks !== false,
    ),
  );
  const pairs = machines.flatMap((a, index) =>
    machines.slice(index + 1).map((b) => ({ a, b, key: `${a.environmentId}:${b.environmentId}` })),
  );
  const needsAttention = (environmentId: EnvironmentId) =>
    pairs.some(
      ({ a, b, key }) =>
        (a.environmentId === environmentId || b.environmentId === environmentId) &&
        attention.get(key) === true,
    );
  const selected =
    chosenTab === OTHER_MACHINES_TAB
      ? undefined
      : (machines.find((machine) => machine.environmentId === chosenTab) ??
        machines.find((machine) => needsAttention(machine.environmentId)) ??
        machines[0]);
  const currentTab = selected?.environmentId ?? OTHER_MACHINES_TAB;
  const knownIds = new Set<EnvironmentId>(machines.map((machine) => machine.environmentId));
  const tabListRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- on a narrow page the default tab can start scrolled out of the strip, and scroll position lives in the DOM
  useEffect(() => {
    const list = tabListRef.current;
    const tab = list?.querySelector<HTMLElement>(`[data-machine-id="${currentTab}"]`);
    if (!list || !tab) return;
    const start = tab.offsetLeft - list.offsetLeft;
    const end = start + tab.offsetWidth;
    if (start < list.scrollLeft) list.scrollLeft = start;
    else if (end > list.scrollLeft + list.clientWidth) list.scrollLeft = end - list.clientWidth;
  }, [currentTab]);
  return (
    <SettingsSection id="work-together" title="Your machines" variant="plain">
      <Tabs.Root value={currentTab} onValueChange={(value: string) => setChosenTab(value)}>
        <Tabs.List
          ref={tabListRef}
          activateOnFocus
          aria-label="Your machines"
          className="relative z-10 -mb-px flex items-end gap-1 overflow-x-auto [scrollbar-width:none]"
        >
          {machines.map((machine) => (
            <MachineTab
              key={machine.environmentId}
              machine={machine}
              machines={machines}
              isSelected={machine.environmentId === currentTab}
              needsAttention={needsAttention(machine.environmentId)}
            />
          ))}
          <Tabs.Tab
            value={OTHER_MACHINES_TAB}
            data-machine-id={OTHER_MACHINES_TAB}
            className={machineTabClassName(currentTab === OTHER_MACHINES_TAB)}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <PlusIcon aria-hidden className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-foreground">
                Other machines
              </span>
              <span className="block truncate text-xs text-muted-foreground">Add or manage</span>
            </span>
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value={currentTab}>
          <SettingsGroup className="min-h-12 rounded-t-none bg-card">
            {selected === undefined ? null : (
              <SettingsRow
                id="machine-access"
                forkFeature="machine-access"
                title={`What your other machines can do on ${selected.label}`}
              >
                <MachineAccessSetting
                  environmentId={selected.environmentId}
                  machineLabel={selected.label}
                  level={selected.serverConfig?.settings.incomingMachineAccess ?? "everything"}
                  supported={
                    selected.serverConfig?.environment.capabilities.incomingMachineAccess === true
                  }
                />
              </SettingsRow>
            )}
            {selected === undefined || pairs.length === 0 ? null : (
              <div className="px-3 py-2 sm:px-4">
                <Button
                  size="xs"
                  variant="ghost-muted"
                  aria-expanded={showOthers}
                  onClick={() => setShowOthers((shown) => !shown)}
                >
                  <ChevronRightIcon className={showOthers ? "size-3 rotate-90" : "size-3"} />
                  Each machine
                </Button>
              </div>
            )}
            {/* Every pair stays mounted, even on another tab, so a run in progress keeps going. */}
            <SettingsGroup className="m-3 empty:hidden sm:mx-4">
              {pairs.map(({ a, b, key }) => (
                <MachinePair
                  key={key}
                  a={a}
                  b={b}
                  selectedId={selected?.environmentId ?? null}
                  expanded={showOthers}
                  onOpen={() => setChosenTab(currentTab)}
                  onAttentionChange={(value) =>
                    setAttention((current) =>
                      current.get(key) === value ? current : new Map(current).set(key, value),
                    )
                  }
                />
              ))}
            </SettingsGroup>
            {selected === undefined ? (
              <>
                <SettingsRow
                  title="Machines this app isn't connected to"
                  description="Your machines can work with these, but this app can't show or change their settings. Add one under Environments to give it a tab."
                  control={<AddMachineAction hosts={hosts} />}
                />
                <SettingsGroup className="m-3 empty:hidden sm:mx-4">
                  {hosts.map((host) => (
                    <OtherMachineLinks
                      key={host.environmentId}
                      environmentId={host.environmentId}
                      environmentLabel={host.label}
                      showHost={hosts.length > 1}
                      knownIds={knownIds}
                    />
                  ))}
                </SettingsGroup>
              </>
            ) : (
              <>
                <MachineDevicesRow machine={selected} machines={machines} />
                <MachineStatusRow machine={selected} machines={machines} />
              </>
            )}
          </SettingsGroup>
        </Tabs.Panel>
      </Tabs.Root>
    </SettingsSection>
  );
}

const OTHER_MACHINES_TAB = "other-machines";

const machineTabClassName = (isSelected: boolean) =>
  cn(
    "flex min-w-52 flex-1 basis-0 cursor-pointer items-center gap-3 rounded-t-xl border border-b-0 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    isSelected
      ? "border-border/60 bg-card pb-3 pt-3"
      : "mb-px border-border/60 bg-muted/60 hover:bg-muted",
  );

const PLATFORM_NAMES: Record<string, string> = {
  ios: "iOS simulators",
  android: "Android emulators",
};

function MachineDevicesRow({
  machine,
  machines,
}: {
  readonly machine: NamedEnvironment;
  readonly machines: ReadonlyArray<NamedEnvironment>;
}) {
  const connected = machine.connection.phase === "connected";
  const { state } = useDeviceState(connected ? machine.environmentId : null);
  if (!connected || state.supportsEnvironmentHosts !== true) return null;
  const names = state.hosts
    .filter((host) => host.kind === "local")
    .flatMap((host) => host.platforms.filter((platform) => platform.available))
    .map((platform) => PLATFORM_NAMES[platform.platform] ?? platform.platform);
  const from = (machine.serverConfig?.settings.environmentDeviceHosts ?? []).flatMap(
    (host) => machines.find((other) => other.environmentId === host.environmentId)?.label ?? [],
  );
  const level = machine.serverConfig?.settings.incomingMachineAccess ?? "everything";
  const here =
    names.length === 0
      ? "No simulators or emulators on this machine."
      : `${names.join(" and ")}. ${
          level === "everything"
            ? "Your other machines can use them."
            : "Other machines can't use them at this setting."
        }`;
  return (
    <SettingsRow
      title="Devices"
      description={
        from.length === 0 ? here : `${here} Agents here can use devices on ${from.join(" and ")}.`
      }
    />
  );
}

function MachineStatusRow({
  machine,
  machines,
}: {
  readonly machine: NamedEnvironment;
  readonly machines: ReadonlyArray<NamedEnvironment>;
}) {
  const connected = machine.connection.phase === "connected";
  const links = useEnvironmentQuery(
    connected
      ? peerLinkEnvironment.list({ environmentId: machine.environmentId, input: {} })
      : null,
  );
  const linkedOthers = machines.filter((other) =>
    links.data?.links.some(
      (link) => link.environmentId === other.environmentId && link.status !== "expired",
    ),
  );
  const named = (level: IncomingMachineAccess) =>
    linkedOthers.filter(
      (other) => (other.serverConfig?.settings.incomingMachineAccess ?? "everything") === level,
    );
  const refusing = named("nothing");
  // Their own setting isn't visible from here, so this can't say what they allow.
  const unconnected = (links.data?.links ?? []).filter(
    (link) =>
      link.status !== "expired" &&
      !machines.some((other) => other.environmentId === link.environmentId),
  );
  const names = (list: ReadonlyArray<{ readonly label: string }>) =>
    machineNames(list.map((entry) => entry.label));
  const parts = [
    named("everything").length > 0 ? `can control ${names(named("everything"))}` : "",
    named("look-only").length > 0 ? `can look at ${names(named("look-only"))}` : "",
    unconnected.length > 0 ? `can work on ${names(unconnected)}` : "",
    refusing.length > 0
      ? `can't reach ${names(refusing)}, which accept${refusing.length === 1 ? "s" : ""} nothing`
      : "",
  ].filter(Boolean);
  return (
    <SettingsRow
      title="Status"
      description={
        !connected
          ? `This app can't reach ${machine.label} right now. Its setting still applies.`
          : parts.length === 0
            ? "Agents here aren't working on other machines yet."
            : `Agents here ${machineNames(parts)}.`
      }
    />
  );
}

function MachineTab({
  machine,
  machines,
  isSelected,
  needsAttention,
}: {
  readonly machine: NamedEnvironment;
  readonly machines: ReadonlyArray<NamedEnvironment>;
  readonly isSelected: boolean;
  readonly needsAttention: boolean;
}) {
  const connected = machine.connection.phase === "connected";
  const links = useEnvironmentQuery(
    connected
      ? peerLinkEnvironment.list({ environmentId: machine.environmentId, input: {} })
      : null,
  );
  const now = DateTime.makeUnsafe(useNowMinute());
  const others = machines.filter((other) => other.environmentId !== machine.environmentId);
  const linked = others.filter((other) =>
    links.data?.links.some(
      (link) => link.environmentId === other.environmentId && link.status !== "expired",
    ),
  );
  const unreachable = connected
    ? linked.find((other) => {
        if (other.connection.phase !== "connected") return false;
        const link = links.data?.links.find((l) => l.environmentId === other.environmentId);
        if (link === undefined) return false;
        const { kind } = peerLinkHealth(link, now);
        return kind === "unreachable" || kind === "failing";
      })
    : undefined;
  const level = machineAccessChoice(
    machine.serverConfig?.settings.incomingMachineAccess ?? "everything",
  );
  const [status, dot] = !connected
    ? (["Not connected", "bg-muted-foreground/30"] as const)
    : links.error
      ? (["Could not check", "bg-warning"] as const)
      : !links.data
        ? (["Checking…", "bg-muted-foreground/30"] as const)
        : unreachable !== undefined
          ? ([`Can't reach ${unreachable.label}`, "bg-destructive"] as const)
          : others.length > 0 && linked.length === 0
            ? (["Not set up yet", "bg-muted-foreground/30"] as const)
            : needsAttention
              ? (["Needs attention", "bg-warning"] as const)
              : level.level === "nothing"
                ? ([level.status, "bg-muted-foreground/30"] as const)
                : ([level.status, "bg-success"] as const);
  const tab = (
    <Tabs.Tab
      value={machine.environmentId}
      data-machine-id={machine.environmentId}
      className={machineTabClassName(isSelected)}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <EnvironmentMachineIcon
          aria-hidden
          kind={resolveEnvironmentMachineKind(machine.serverConfig)}
          className="size-4"
        />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{machine.label}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ConnectionStatusDot dotClassName={dot} pingClassName={null} />
          <span className="min-w-0 truncate">{status}</span>
        </span>
      </span>
    </Tabs.Tab>
  );
  // A tab's name truncates past about this length, so the full name needs a way to be read.
  if (machine.identityDetail === null && machine.label.length <= 16) return tab;
  return (
    <Tooltip>
      <TooltipTrigger render={tab} />
      <TooltipPopup>{machine.identityDetail ?? machine.label}</TooltipPopup>
    </Tooltip>
  );
}

function useWorkTogetherMachine(
  environment: NamedEnvironment,
  other: Environment,
): Omit<WorkTogetherMachine, "links"> & { readonly links: ReadonlyArray<PeerLinkSummary> | null } {
  const { environmentId, serverConfig } = environment;
  const connected = environment.connection.phase === "connected";
  const links = useEnvironmentQuery(
    connected ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  const known = useLinkableMachines(other.environmentId, true).find(
    (machine) => machine.environmentId === environmentId,
  );
  const { addresses } = useDeviceSharingAddresses(environment);
  const device = useDeviceState(connected ? environmentId : null);
  const mayManageAccess = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const mayChangeSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  return {
    environmentId,
    label: environment.label,
    identityDetail: environment.identityDetail,
    identityIcon: environment.identityIcon,
    ownLabel: serverConfig?.environment.label ?? null,
    connected,
    loaded: connected && (links.data !== null || links.error !== null) && device.settled,
    canManage: mayManageAccess && mayChangeSettings,
    allowsLinks: serverConfig?.settings.linkedEnvironmentsEnabled === true,
    links: connected ? (links.data?.links ?? null) : null,
    urls: known?.urls ?? [],
    deviceUrls: addresses,
    hasDevices:
      serverConfig?.settings.incomingMachineAccess !== "view-only" &&
      serverConfig?.settings.incomingMachineAccess !== "nothing" &&
      device.state.supportsEnvironmentHosts === true &&
      device.state.hosts.some(
        (host) => host.kind === "local" && host.platforms.some((platform) => platform.available),
      ),
    usesSharedDevices: device.state.supportsEnvironmentHostAddresses === true,
    sharedDeviceHosts: serverConfig?.settings.environmentDeviceHosts ?? [],
  };
}

interface Run {
  readonly kind: RunKind;
  readonly lines: ReadonlyArray<WorkTogetherLine>;
  readonly finished: boolean;
}

function MachinePair({
  a: first,
  b: second,
  selectedId,
  expanded,
  onOpen,
  onAttentionChange,
}: {
  readonly a: NamedEnvironment;
  readonly b: NamedEnvironment;
  readonly selectedId: EnvironmentId | null;
  /** Shows the pair even when nothing needs doing, so it can be stopped. */
  readonly expanded: boolean;
  /** Keeps this tab selected through a run, even once the pair no longer needs attention. */
  readonly onOpen: () => void;
  readonly onAttentionChange: (needsAttention: boolean) => void;
}) {
  const a = useWorkTogetherMachine(first, second);
  const b = useWorkTogetherMachine(second, first);
  const execute = useAtomCommand(workTogether, { reportFailure: false, reportDefect: false });
  const [dialog, setDialog] = useState<RunKind | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  // Stays on the row after the dialog closes, so "update it first" isn't lost with the list.
  const [lastFailure, setLastFailure] = useState<string | null>(null);
  const status = workTogetherStatus(a, b);
  const label = (
    <>
      <MachineName machine={a} kind={resolveEnvironmentMachineKind(first.serverConfig)} /> and{" "}
      <MachineName machine={b} kind={resolveEnvironmentMachineKind(second.serverConfig)} />
    </>
  );
  const now = DateTime.makeUnsafe(useNowMinute());
  // A machine that is asleep is expected not to answer, and the card already says so.
  const linkProblems =
    a.connected && b.connected
      ? [
          { from: a, to: b },
          { from: b, to: a },
        ].flatMap(({ from, to }) => {
          const link = from.links?.find(
            (candidate) => candidate.environmentId === to.environmentId,
          );
          if (link === undefined) return [];
          const health = peerLinkHealth(link, now);
          return (health.kind === "reachable" && health.expiresInDays === null) ||
            health.kind === "expired"
            ? []
            : [`${from.label} to ${to.label}: ${peerLinkHealthText(health)}`];
        })
      : [];
  const absent = [a, b].find((machine) => !machine.connected);
  const loading = [a, b].some((machine) => machine.connected && !machine.loaded);
  const missingShares = workTogetherMissingShares(a, b);
  const narrower = workTogetherHasNarrowerAccess(a, b);
  const unmanaged = [a, b].find((machine) => machine.connected && !machine.canManage);
  const running = run !== null && !run.finished;
  const waiting =
    run !== null && run.finished && run.lines.some((line) => line.status.state === "waiting");

  const openDialog = (kind: RunKind) => {
    onOpen();
    // A run left waiting stays on screen only for the same action.
    if (run?.kind !== kind && !running) {
      setRun(null);
    }
    setDialog(kind);
  };

  const start = async (kind: RunKind) => {
    const lines =
      kind === "start"
        ? planWorkTogether(a, b, LINK_DEFAULT_ACCESS)
        : planStopWorkingTogether(a, b);
    setRun({ kind, lines, finished: false });
    setLastFailure(null);
    const result = await execute({
      lines,
      access: LINK_DEFAULT_ACCESS,
      onUpdate: (next) => setRun({ kind, lines: next, finished: false }),
    });
    if (result._tag === "Failure") {
      const message = workTogetherFailureMessage(squashAtomCommandFailure(result));
      setRun({
        kind,
        lines: lines.map((line) =>
          line.status.state === "done" ? line : { ...line, status: { state: "failed", message } },
        ),
        finished: true,
      });
      setLastFailure(message);
      return;
    }
    setRun({ kind, lines: result.value, finished: true });
    const failed = result.value.find((line) => line.status.state === "failed")?.status;
    setLastFailure(failed?.state === "failed" ? failed.message : null);
    const target = [a, b].find((machine) => machine.connected);
    if (target !== undefined) {
      void reportForkClientUsage(target.environmentId, {
        feature: "work-together",
        action: kind,
        outcome: workTogetherOutcome(result.value),
      });
    }
  };

  const resume = useEffectEvent(() => {
    if (run !== null) void start(run.kind);
  });
  const bothLoaded = a.loaded && b.loaded;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a machine that wakes while this page is open finishes the run that was waiting for it
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the run starts on a connection change outside React
    if (waiting && bothLoaded) resume();
  }, [waiting, bothLoaded]);

  const needsAttention =
    lastFailure !== null || linkProblems.length > 0 || workTogetherNeedsAttention(a, b);
  const reportAttention = useEffectEvent(onAttentionChange);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- each pair reads its two machines through hooks, so the tabs above can only learn the result from here
  useEffect(() => {
    reportAttention(needsAttention);
  }, [needsAttention]);
  const other =
    first.environmentId === selectedId ? { machine: b, env: second } : { machine: a, env: first };
  const shown =
    (first.environmentId === selectedId || second.environmentId === selectedId) &&
    (expanded || needsAttention || narrower);
  const narrowest = [...(a.links ?? []), ...(b.links ?? [])].find(
    (link) =>
      (link.environmentId === a.environmentId || link.environmentId === b.environmentId) &&
      link.access !== LINK_DEFAULT_ACCESS,
  );

  return (
    <>
      {shown ? (
        <SettingsRow
          title={
            <MachineName
              machine={other.machine}
              kind={resolveEnvironmentMachineKind(other.env.serverConfig)}
            />
          }
          status={
            status === "together"
              ? absent === undefined
                ? missingShares.length > 0
                  ? `Working together · Sharing isn't set up for ${missingShares.map(({ device }) => device.label).join(" or ")}`
                  : narrowest === undefined
                    ? "Working together"
                    : `Working together · ${linkAccessLabel(narrowest.access)}`
                : `Working together · ${absent.label} isn't connected`
              : status === "partial"
                ? absent === undefined
                  ? "Partly set up"
                  : `Partly set up · ${absent.label} isn't connected`
                : undefined
          }
          description={
            unmanaged !== undefined
              ? `This app can't change access on ${unmanaged.label}. Pair it again from there to manage it.`
              : lastFailure !== null
                ? lastFailure
                : status === "separate"
                  ? absent === undefined
                    ? "Agents on each can start and message threads on the other."
                    : `${absent.label} isn't connected. Start now and it finishes when ${absent.label} is back.`
                  : status === "partial"
                    ? "Finish setting them up, or stop to undo what's there."
                    : linkProblems.length > 0
                      ? linkProblems.join(" ")
                      : undefined
          }
          control={
            unmanaged !== undefined ? null : (
              <div className="flex items-center gap-2">
                {status === "separate" ? null : (
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    disabled={loading}
                    onClick={() => openDialog("stop")}
                  >
                    Stop working together
                  </Button>
                )}
                {status === "together" && missingShares.length === 0 && !narrower ? null : (
                  <Button size="xs" disabled={loading} onClick={() => openDialog("start")}>
                    {status === "separate" ? "Work together" : "Finish"}
                  </Button>
                )}
              </div>
            )
          }
        />
      ) : null}
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (open || running) return;
          setDialog(null);
          if (!waiting) setRun(null);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            {run === null ? (
              <DialogDescription>
                {dialog === "stop" ? (
                  "Agents on each machine stop working on the other, and device sharing between them ends. Tasks one has delegated to the other fail. The switches in Labs and Devices stay as they are."
                ) : (
                  <WorkTogetherSummary a={a} b={b} />
                )}
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogPanel>
            {run !== null ? <WorkTogetherProgress lines={run.lines} /> : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <WorkTogetherFooter
              kind={dialog ?? "start"}
              run={run}
              onClose={() => {
                setDialog(null);
                if (!waiting) setRun(null);
              }}
              onStart={() => {
                if (dialog !== null) void start(dialog);
              }}
            />
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function WorkTogetherSummary(props: {
  readonly a: WorkTogetherMachine;
  readonly b: WorkTogetherMachine;
}) {
  const shares = workTogetherSharedDevices(props.a, props.b);
  return (
    <>
      Agents on each can start and message threads on the other
      {shares.map(({ device, agent }, index) => (
        <span key={device.environmentId}>
          {index === 0 ? ", and " : " and "}
          {agent.label} can use {device.label}'s devices
        </span>
      ))}
      .
    </>
  );
}

function WorkTogetherFooter(props: {
  readonly kind: RunKind;
  readonly run: Run | null;
  readonly onClose: () => void;
  readonly onStart: () => void;
}) {
  const { kind, run } = props;
  if (run === null) {
    return (
      <>
        <Button variant="outline" onClick={props.onClose}>
          Cancel
        </Button>
        <Button
          {...(kind === "stop" ? { variant: "destructive" as const } : {})}
          onClick={props.onStart}
        >
          {kind === "stop" ? "Stop working together" : "Work together"}
        </Button>
      </>
    );
  }
  if (!run.finished) return <Button disabled>{kind === "stop" ? "Stopping…" : "Working…"}</Button>;
  const outcome = workTogetherOutcome(run.lines);
  return (
    <>
      <Button variant={outcome === "failed" ? "outline" : "default"} onClick={props.onClose}>
        {outcome === "complete" ? "Done" : "Close"}
      </Button>
      {outcome === "failed" ? <Button onClick={props.onStart}>Try again</Button> : null}
    </>
  );
}

/** One line per step, in order. What finished stays finished when a later line cannot. */
function WorkTogetherProgress({ lines }: { readonly lines: ReadonlyArray<WorkTogetherLine> }) {
  return (
    <ul className="space-y-2" aria-live="polite">
      {lines.map((line) => (
        <li key={line.id} className="flex items-start gap-2 text-sm">
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
            <WorkTogetherLineIcon line={line} />
          </span>
          <span className="min-w-0">
            <span
              className={line.status.state === "done" ? "text-foreground" : "text-muted-foreground"}
            >
              {line.label}
            </span>
            <WorkTogetherLineDetail line={line} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function WorkTogetherLineIcon({ line }: { readonly line: WorkTogetherLine }) {
  switch (line.status.state) {
    case "done":
      return <CheckIcon aria-label="Done" className="size-4 text-success" />;
    case "running":
      return <Spinner aria-label="In progress" size="sm" />;
    case "waiting":
      return <ClockIcon aria-label="Waiting" className="size-3.5 text-warning" />;
    case "failed":
      return <CircleAlertIcon aria-label="Failed" className="size-3.5 text-destructive" />;
    case "blocked":
      return <MinusIcon aria-label="Not run" className="size-3.5 text-muted-foreground" />;
    case "pending":
      return <CircleIcon aria-label="Not started" className="size-2.5 text-muted-foreground/60" />;
  }
}

function WorkTogetherLineDetail({ line }: { readonly line: WorkTogetherLine }) {
  switch (line.status.state) {
    case "waiting":
      return (
        <span className="block text-xs text-muted-foreground">
          Finishes when {line.status.machine} is back, if this page is still open. Otherwise, run
          this again then.
        </span>
      );
    case "failed":
      return <span className="block text-xs text-destructive">{line.status.message}</span>;
    case "blocked":
      return (
        <span className="block text-xs text-muted-foreground">
          Needs a step above to finish first.
        </span>
      );
    default:
      return null;
  }
}

function MachineName({
  machine,
  kind,
}: {
  readonly machine: Pick<WorkTogetherMachine, "label" | "identityDetail" | "identityIcon">;
  /** Null hides the icon. Left out, it shows only when two machines share a name. */
  readonly kind?: EnvironmentMachineKind | null;
}) {
  const icon = kind === undefined ? machine.identityIcon : kind;
  const name = (
    <span className="inline-flex max-w-full items-center gap-1.5 align-bottom">
      {icon ? (
        <EnvironmentMachineIcon
          kind={icon}
          className="size-[1em] shrink-0 text-muted-foreground"
          aria-hidden
        />
      ) : null}
      <span className="min-w-0 break-words">{machine.label}</span>
    </span>
  );
  if (!machine.identityDetail || !machine.label.includes("…")) return name;
  return (
    <Tooltip>
      <TooltipTrigger render={name} tabIndex={0} />
      <TooltipPopup>{machine.identityDetail}</TooltipPopup>
    </Tooltip>
  );
}
