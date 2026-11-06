import {
  LINK_DEFAULT_ACCESS,
  linkAccessLabel,
  MACHINE_ACCESS_CHOICES,
  machineAccessChoice,
  machineAccessStopNotice,
  machineNames,
} from "@t3tools/client-runtime/link-request";
import { deviceSharingAddresses } from "@t3tools/client-runtime/state/device";
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
  workTogetherNeedsAttention,
  workTogetherMissingShares,
  workTogetherOutcome,
  workTogetherSharedDevices,
  workTogetherStatus,
} from "@t3tools/client-runtime/state/workTogether";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type IncomingMachineAccess,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { useEffect, useEffectEvent, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { cn } from "../../lib/cn";
import { serverEnvironment } from "../../state/server";
import { useDeviceState } from "../../state/device";
import { useEnvironments } from "../../state/environments";
import { reportForkClientUsage } from "../../state/forkClientUsage";
import { peerLinkEnvironment, useLinkableMachines, workTogether } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

type Environment = ReturnType<typeof useEnvironments>["environments"][number];
type NamedEnvironment = Environment & WorkTogetherIdentity;
type RunKind = "start" | "stop";

interface Run {
  readonly kind: RunKind;
  readonly lines: ReadonlyArray<WorkTogetherLine>;
  readonly finished: boolean;
}

/**
 * One tab per machine, joined to a panel with its setting, devices, status and anything to do.
 * Every pair stays mounted so a run survives switching tabs. The phone is a client, never a tab.
 */
export function WorkTogetherSection() {
  const { environments } = useEnvironments();
  const [chosenId, setChosenId] = useState<EnvironmentId | null>(null);
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
    machines.find((machine) => machine.environmentId === chosenId) ??
    machines.find((machine) => needsAttention(machine.environmentId)) ??
    machines[0];
  if (selected === undefined) return null;
  return (
    <View className="mt-5 gap-2">
      <Text className="px-4 font-t3-bold text-base text-foreground">Your machines</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="tablist"
        className="z-10 -mb-px"
      >
        <View className="min-w-full flex-row items-end gap-1">
          {machines.map((machine) => (
            <MachineTab
              key={machine.environmentId}
              machine={machine}
              isSelected={machine.environmentId === selected.environmentId}
              needsAttention={needsAttention(machine.environmentId)}
              machineCount={machines.length}
              onPress={() => setChosenId(machine.environmentId)}
            />
          ))}
        </View>
      </ScrollView>
      <View className="-mt-2 rounded-b-2xl border border-border bg-grouped-card">
        <MachineAccessChoices machine={selected} />
        {pairs.map(({ a, b, key }) => (
          <MachinePair
            key={key}
            a={a}
            b={b}
            selectedId={selected.environmentId}
            expanded={showOthers}
            onOpen={() => setChosenId(selected.environmentId)}
            onAttentionChange={(value) =>
              setAttention((current) =>
                current.get(key) === value ? current : new Map(current).set(key, value),
              )
            }
          />
        ))}
        <OtherMachineLinks machine={selected} machines={machines} />
        <MachineStatus machine={selected} machines={machines} />
        {pairs.length === 0 ? null : (
          <View className="border-t border-border p-3">
            <Button
              label={showOthers ? "Hide other machines" : "Each machine"}
              tone="secondary"
              onPress={() => setShowOthers((shown) => !shown)}
            />
          </View>
        )}
      </View>
    </View>
  );
}

function MachineTab(props: {
  readonly machine: NamedEnvironment;
  readonly isSelected: boolean;
  readonly needsAttention: boolean;
  readonly machineCount: number;
  readonly onPress: () => void;
}) {
  const { machine } = props;
  const level = machineAccessChoice(
    machine.serverConfig?.settings.incomingMachineAccess ?? "everything",
  );
  const connected = machine.connection.phase === "connected";
  const status = !connected
    ? "Not connected"
    : props.needsAttention
      ? "Needs attention"
      : level.status;
  const dot =
    !connected || level.level === "nothing"
      ? "bg-foreground-muted"
      : props.needsAttention
        ? "bg-warning"
        : "bg-success";
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: props.isSelected }}
      accessibilityLabel={`${machine.label}, ${status}`}
      onPress={props.onPress}
      className={cn(
        "min-w-44 flex-1 flex-row items-center gap-2 rounded-t-2xl border border-b-0 border-border px-3",
        props.isSelected ? "bg-grouped-card py-3" : "mb-px bg-subtle py-2.5",
      )}
    >
      <EnvironmentMachineSymbol
        kind={resolveEnvironmentMachineKind(machine.serverConfig)}
        size={18}
        tintColorClassName="accent-foreground-muted"
      />
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="font-t3-bold text-sm text-foreground">
          {machine.label}
        </Text>
        <View className="flex-row items-center gap-1.5">
          <View className={cn("size-2 rounded-full", dot)} />
          <Text numberOfLines={1} className="flex-1 text-xs text-foreground-muted">
            {status}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

function MachineAccessChoices({ machine }: { readonly machine: NamedEnvironment }) {
  const { environmentId, label, serverConfig } = machine;
  const level = serverConfig?.settings.incomingMachineAccess ?? "everything";
  const supported = serverConfig?.environment.capabilities.incomingMachineAccess === true;
  const mayChange = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const incomingWork = useAtomCommand(peerLinkEnvironment.incomingWork, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const save = async (next: IncomingMachineAccess, stoppedThreads: boolean) => {
    const result = await update({
      environmentId,
      input: { patch: { incomingMachineAccess: next } },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      Alert.alert(
        "Setting not saved",
        `Could not save on ${label}. Check that it's connected, then try again.`,
      );
      return;
    }
    void reportForkClientUsage(environmentId, {
      feature: "machine-access",
      action: "set",
      level: next,
      stoppedThreads,
    });
  };
  const choose = async (next: IncomingMachineAccess) => {
    if (next === level) return;
    setBusy(true);
    if (next === "everything") return save(next, false);
    const work = await incomingWork({ environmentId, input: {} });
    // Without a count, nobody can agree to what would stop.
    if (work._tag === "Failure") {
      setBusy(false);
      Alert.alert("Setting not saved", `Could not check what's running on ${label}. Try again.`);
      return;
    }
    const { runningThreads } = work.value;
    if (runningThreads === 0) return save(next, false);
    Alert.alert("Stop running threads?", machineAccessStopNotice(label, next, runningThreads), [
      { text: "Cancel", style: "cancel", onPress: () => setBusy(false) },
      { text: "Stop them", style: "destructive", onPress: () => void save(next, true) },
    ]);
  };
  const disabled = busy || !supported || !mayChange;
  return (
    <View>
      <Text className="px-4 pt-4 font-t3-bold text-sm text-foreground">
        What your other machines can do on {label}
      </Text>
      {MACHINE_ACCESS_CHOICES.map((choice, index) => (
        <ListChoiceRow
          key={choice.level}
          label={choice.label}
          description={choice.description}
          selected={choice.level === level}
          separated={index > 0}
          disabled={disabled}
          onPress={() => void choose(choice.level)}
        />
      ))}
      {!supported ? (
        <Text className="px-4 pb-3 text-xs text-foreground-muted">
          Update styal on {label} to choose this.
        </Text>
      ) : !mayChange ? (
        <Text className="px-4 pb-3 text-xs text-foreground-muted">
          This app can't change access on {label}. Pair it again from there to manage it.
        </Text>
      ) : null}
    </View>
  );
}

/** Machines this one reaches that the app isn't connected to, which no pair can show. */
function OtherMachineLinks(props: {
  readonly machine: NamedEnvironment;
  readonly machines: ReadonlyArray<NamedEnvironment>;
}) {
  const { machine, machines } = props;
  const connected = machine.connection.phase === "connected";
  const canRead = useEnvironmentScope(machine.environmentId, AuthAccessReadScope);
  const links = useEnvironmentQuery(
    connected && canRead
      ? peerLinkEnvironment.list({ environmentId: machine.environmentId, input: {} })
      : null,
  );
  const known = new Set<EnvironmentId>(machines.map((other) => other.environmentId));
  const others = (links.data?.links ?? []).filter((link) => !known.has(link.environmentId));
  if (others.length === 0) {
    return machines.length > 1 || !links.data ? null : (
      <View className="gap-0.5 border-t border-border p-4">
        <Text className="font-t3-bold text-sm text-foreground">Add another machine first</Text>
        <Text className="text-xs text-foreground-muted">
          Add one under Environments so your machines can work on each other and share simulators.
        </Text>
      </View>
    );
  }
  return (
    <>
      <View className="gap-0.5 border-t border-border p-4">
        <Text className="font-t3-bold text-sm text-foreground">
          Other machines {machine.label} works with
        </Text>
        <Text className="text-xs text-foreground-muted">
          This app isn't connected to these. Add one under Environments to give it a tab here.
        </Text>
      </View>
      {others.map((link) => (
        <View key={link.environmentId} className="gap-0.5 border-t border-border p-4">
          <Text className="font-t3-bold text-sm text-foreground">{link.label}</Text>
          {link.access === LINK_DEFAULT_ACCESS ? null : (
            <Text className="text-xs text-foreground-muted">{linkAccessLabel(link.access)}</Text>
          )}
        </View>
      ))}
    </>
  );
}

function MachineStatus(props: {
  readonly machine: NamedEnvironment;
  readonly machines: ReadonlyArray<NamedEnvironment>;
}) {
  const { machine, machines } = props;
  const connected = machine.connection.phase === "connected";
  const { state } = useDeviceState(connected ? machine.environmentId : null);
  const links = useEnvironmentQuery(
    connected
      ? peerLinkEnvironment.list({ environmentId: machine.environmentId, input: {} })
      : null,
  );
  const named = (level: IncomingMachineAccess) =>
    machineNames(
      machines
        .filter(
          (other) =>
            links.data?.links.some(
              (link) => link.environmentId === other.environmentId && link.status !== "expired",
            ) && (other.serverConfig?.settings.incomingMachineAccess ?? "everything") === level,
        )
        .map((other) => other.label),
    );
  const unconnected = machineNames(
    (links.data?.links ?? [])
      .filter(
        (link) =>
          link.status !== "expired" &&
          !machines.some((other) => other.environmentId === link.environmentId),
      )
      .map((link) => link.label),
  );
  const parts = [
    named("everything") && `can control ${named("everything")}`,
    named("view-only") && `can view ${named("view-only")}`,
    unconnected && `can work on ${unconnected}`,
    named("nothing") && `can't reach ${named("nothing")}`,
  ].filter(Boolean);
  const devices = state.hosts
    .filter((host) => host.kind === "local")
    .flatMap((host) => host.platforms.filter((platform) => platform.available));
  const access = machine.serverConfig?.settings.incomingMachineAccess ?? "everything";
  return (
    <View className="gap-1 border-t border-border p-4">
      <Text className="text-xs text-foreground-muted">
        {!connected
          ? `This app can't reach ${machine.label} right now. Its setting still applies.`
          : parts.length === 0
            ? "Agents here aren't working on other machines yet."
            : `Agents here ${machineNames(parts)}.`}
      </Text>
      {connected && devices.length > 0 ? (
        <Text className="text-xs text-foreground-muted">
          {access === "everything"
            ? "Your other machines can use its simulators and emulators."
            : "Other machines can't use its simulators and emulators at this setting."}
        </Text>
      ) : null}
    </View>
  );
}

function useWorkTogetherMachine(
  environment: NamedEnvironment,
  other: Environment,
): WorkTogetherMachine {
  const { environmentId, serverConfig } = environment;
  const connected = environment.connection.phase === "connected";
  const links = useEnvironmentQuery(
    connected ? peerLinkEnvironment.list({ environmentId, input: {} }) : null,
  );
  const known = useLinkableMachines(other.environmentId, true).find(
    (machine) => machine.environmentId === environmentId,
  );
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const linkUrl = useAtomValue(relayEnvironmentDiscovery.stateValueAtom).environments.get(
    environmentId,
  )?.environment.endpoint.httpBaseUrl;
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
    deviceUrls: deviceSharingAddresses({
      clientUrl: prepared?.httpBaseUrl ?? null,
      directEndpoints: serverConfig?.directEndpoints,
      linkUrl,
    }),
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

function MachinePair(props: {
  readonly a: NamedEnvironment;
  readonly b: NamedEnvironment;
  readonly selectedId: EnvironmentId;
  /** Shows the pair even when nothing needs doing, so it can be stopped. */
  readonly expanded: boolean;
  /** Keeps this tab selected through a run, even once the pair no longer needs attention. */
  readonly onOpen: () => void;
  readonly onAttentionChange: (needsAttention: boolean) => void;
}) {
  const a = useWorkTogetherMachine(props.a, props.b);
  const b = useWorkTogetherMachine(props.b, props.a);
  const execute = useAtomCommand(workTogether, { reportFailure: false, reportDefect: false });
  const [sheet, setSheet] = useState<RunKind | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const status = workTogetherStatus(a, b);
  const absent = [a, b].find((machine) => !machine.connected);
  const loading = [a, b].some((machine) => machine.connected && !machine.loaded);
  const missingShares = workTogetherMissingShares(a, b);
  const narrower = workTogetherHasNarrowerAccess(a, b);
  const unmanaged = [a, b].find((machine) => machine.connected && !machine.canManage);
  const running = run !== null && !run.finished;
  const waiting =
    run !== null && run.finished && run.lines.some((line) => line.status.state === "waiting");

  const needsAttention = workTogetherNeedsAttention(a, b);
  const reportAttention = useEffectEvent(props.onAttentionChange);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- each pair reads its two machines through hooks, so the tabs above can only learn the result from here
  useEffect(() => {
    reportAttention(needsAttention);
  }, [needsAttention]);
  const other = props.a.environmentId === props.selectedId ? b : a;
  const shown =
    (props.a.environmentId === props.selectedId || props.b.environmentId === props.selectedId) &&
    (props.expanded || needsAttention || narrower);

  const openSheet = (kind: RunKind) => {
    props.onOpen();
    // A run left waiting stays on screen only for the same action.
    if (run?.kind !== kind && !running) {
      setRun(null);
    }
    setSheet(kind);
  };
  const closeSheet = () => {
    if (running) return;
    setSheet(null);
    if (!waiting) setRun(null);
  };

  const start = async (kind: RunKind) => {
    const lines =
      kind === "start"
        ? planWorkTogether(a, b, LINK_DEFAULT_ACCESS)
        : planStopWorkingTogether(a, b);
    setRun({ kind, lines, finished: false });
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
      return;
    }
    setRun({ kind, lines: result.value, finished: true });
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a machine that wakes while this screen is open finishes the run that was waiting for it
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the run starts on a connection change outside React
    if (waiting && bothLoaded) resume();
  }, [waiting, bothLoaded]);

  const summary =
    unmanaged !== undefined
      ? `This app can't change access on ${unmanaged.label}. Pair it again from there to manage it.`
      : status === "together"
        ? absent === undefined
          ? missingShares.length > 0
            ? `Working together · Sharing isn't set up for ${missingShares.map(({ device }) => device.label).join(" or ")}`
            : "Working together"
          : `Working together · ${absent.label} isn't connected`
        : status === "partial"
          ? absent === undefined
            ? "Partly set up. Finish, or stop to undo what's there."
            : `Partly set up · ${absent.label} isn't connected`
          : absent === undefined
            ? "Agents on each can start and message threads on the other."
            : `${absent.label} isn't connected. Start now and it finishes when ${absent.label} is back.`;

  return (
    <>
      {shown ? (
        <View className="gap-3 border-t border-border p-4">
          <View className="gap-0.5">
            <Text className="font-t3-bold text-base text-foreground">{other.label}</Text>
            <Text className="text-xs text-foreground-muted">{summary}</Text>
          </View>
          {unmanaged !== undefined ? null : (
            <View className="flex-row flex-wrap gap-2">
              {status === "together" && missingShares.length === 0 && !narrower ? null : (
                <Button
                  label={status === "separate" ? "Work together" : "Finish"}
                  tone="primary"
                  disabled={loading}
                  onPress={() => openSheet("start")}
                />
              )}
              {status === "separate" ? null : (
                <Button
                  label="Stop working together"
                  tone="danger"
                  disabled={loading}
                  onPress={() => openSheet("stop")}
                />
              )}
            </View>
          )}
        </View>
      ) : null}
      {sheet === null ? null : (
        <WorkTogetherSheet
          kind={sheet}
          a={a}
          b={b}
          run={run}
          onStart={() => void start(sheet)}
          onClose={closeSheet}
        />
      )}
    </>
  );
}

function WorkTogetherSheet(props: {
  readonly kind: RunKind;
  readonly a: WorkTogetherMachine;
  readonly b: WorkTogetherMachine;
  readonly run: Run | null;
  readonly onStart: () => void;
  readonly onClose: () => void;
}) {
  const { kind, a, b, run } = props;
  const insets = useSafeAreaInsets();
  const shares = workTogetherSharedDevices(a, b);
  const outcome = run?.finished ? workTogetherOutcome(run.lines) : null;
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <ScrollView
        className="flex-1 bg-sheet-solid"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{
          paddingBottom: insets.bottom + 20,
          // An iOS page sheet already sits below the status bar.
          ...(Platform.OS === "android" ? { paddingTop: insets.top + 20 } : {}),
        }}
      >
        <View className="gap-1">
          <MachinePairName a={a} b={b} large />
          {[a, b]
            .filter((machine) => machine.identityDetail && machine.label.includes("…"))
            .map((machine) => (
              <Text
                key={machine.environmentId}
                selectable
                className="text-xs text-foreground-muted"
              >
                {machine.identityDetail}
              </Text>
            ))}
          {run !== null ? null : (
            <Text className="font-sans text-sm leading-5 text-foreground-muted">
              {kind === "stop"
                ? "Agents on each machine stop working on the other, and device sharing between them ends. Tasks one has delegated to the other fail. The switches in Labs and Devices stay as they are."
                : `Agents on each can start and message threads on the other${shares
                    .map(
                      ({ device, agent }, index) =>
                        `${index === 0 ? ", and " : " and "}${agent.label} can use ${device.label}'s devices`,
                    )
                    .join("")}.`}
            </Text>
          )}
        </View>
        {run !== null ? (
          <View className="gap-3" accessibilityLiveRegion="polite">
            {run.lines.map((line) => (
              <WorkTogetherLineRow key={line.id} line={line} />
            ))}
          </View>
        ) : null}
        {run === null ? (
          <>
            <Button
              label={kind === "stop" ? "Stop working together" : "Work together"}
              tone={kind === "stop" ? "danger" : "primary"}
              onPress={props.onStart}
              fullWidth
            />
            <Button label="Cancel" tone="secondary" onPress={props.onClose} fullWidth />
          </>
        ) : outcome === null ? (
          <Button
            label={kind === "stop" ? "Stopping…" : "Working…"}
            tone="primary"
            disabled
            onPress={() => {}}
            fullWidth
          />
        ) : (
          <>
            {outcome === "failed" ? (
              <Button label="Try again" tone="primary" onPress={props.onStart} fullWidth />
            ) : null}
            <Button
              label={outcome === "complete" ? "Done" : "Close"}
              tone={outcome === "failed" ? "secondary" : "primary"}
              onPress={props.onClose}
              fullWidth
            />
          </>
        )}
      </ScrollView>
    </Modal>
  );
}

const LINE_SYMBOLS: Partial<
  Record<
    WorkTogetherLine["status"]["state"],
    { readonly name: AppSymbolName; readonly label: string }
  >
> = {
  done: { name: "checkmark", label: "Done" },
  waiting: { name: "clock", label: "Waiting" },
  failed: { name: { ios: "exclamationmark.circle", android: "error" }, label: "Failed" },
  blocked: { name: "minus", label: "Not run" },
  pending: { name: "circle", label: "Not started" },
};

/** One step, in the same order and with the same words as web. */
function WorkTogetherLineRow({ line }: { readonly line: WorkTogetherLine }) {
  const { status } = line;
  const symbol = LINE_SYMBOLS[status.state];
  return (
    <View className="flex-row items-start gap-2.5">
      <View className="size-5 items-center justify-center">
        {symbol === undefined ? (
          <ActivityIndicator size="small" accessibilityLabel="In progress" />
        ) : (
          <SymbolView
            name={symbol.name}
            size={15}
            tintColorClassName={
              status.state === "done"
                ? "accent-foreground"
                : status.state === "failed"
                  ? "accent-danger-foreground"
                  : "accent-foreground-muted"
            }
            type="monochrome"
            accessibilityLabel={symbol.label}
          />
        )}
      </View>
      <View className="flex-1 gap-0.5">
        <Text
          className={
            status.state === "done"
              ? "font-sans text-sm text-foreground"
              : "font-sans text-sm text-foreground-muted"
          }
        >
          {line.label}
        </Text>
        {status.state === "waiting" ? (
          <Text className="font-sans text-xs text-foreground-muted">
            Finishes when {status.machine} is back, if this screen is still open. Otherwise, run
            this again then.
          </Text>
        ) : status.state === "failed" ? (
          <Text className="font-sans text-xs text-danger-foreground">{status.message}</Text>
        ) : status.state === "blocked" ? (
          <Text className="font-sans text-xs text-foreground-muted">
            Needs a step above to finish first.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function MachinePairName({
  a,
  b,
  large = false,
}: {
  readonly a: WorkTogetherMachine;
  readonly b: WorkTogetherMachine;
  readonly large?: boolean;
}) {
  const textClass = large
    ? "min-w-0 flex-shrink font-t3-bold text-lg text-foreground"
    : "min-w-0 flex-shrink font-t3-bold text-base text-foreground";
  return (
    <View className="flex-row flex-wrap items-center gap-1">
      {[a, b].map((machine, index) => (
        <View key={machine.environmentId} className="max-w-full flex-row items-center gap-1">
          {index === 1 ? <Text className={textClass}>and </Text> : null}
          {machine.identityIcon ? (
            <EnvironmentMachineSymbol
              kind={machine.identityIcon}
              size={16}
              tintColorClassName="accent-foreground-muted"
            />
          ) : null}
          <Text className={textClass}>{machine.label}</Text>
        </View>
      ))}
    </View>
  );
}
