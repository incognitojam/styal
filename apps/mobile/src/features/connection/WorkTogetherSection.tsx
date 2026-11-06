import { LINK_DEFAULT_ACCESS } from "@t3tools/client-runtime/link-request";
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
  workTogetherMissingShares,
  workTogetherOutcome,
  workTogetherSharedDevices,
  workTogetherStatus,
} from "@t3tools/client-runtime/state/workTogether";
import { AuthAccessWriteScope, AuthSettingsWriteScope } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { useEffect, useEffectEvent, useState } from "react";
import { ActivityIndicator, Modal, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useDeviceState } from "../../state/device";
import { useEnvironments } from "../../state/environments";
import { reportForkClientUsage } from "../../state/forkClientUsage";
import { peerLinkEnvironment, useLinkableMachines, workTogether } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

type Environment = ReturnType<typeof useEnvironments>["environments"][number];
type NamedEnvironment = Environment & WorkTogetherIdentity;
type RunKind = "start" | "stop";

interface Run {
  readonly kind: RunKind;
  readonly lines: ReadonlyArray<WorkTogetherLine>;
  readonly finished: boolean;
}

/** Each pair of the machines this app knows. The phone is a client, so it is never one. */
export function WorkTogetherSection() {
  const { environments } = useEnvironments();
  const machines = workTogetherLabels(
    environments.filter(
      (environment) => environment.serverConfig?.environment.capabilities.peerLinks !== false,
    ),
  );
  const pairs = machines.flatMap((a, index) =>
    machines.slice(index + 1).map((b) => [a, b] as const),
  );
  if (pairs.length === 0) return null;
  return (
    <View className="mt-5 gap-3">
      <SettingsSection title="Work together">
        {pairs.map(([a, b]) => (
          <MachinePair key={`${a.environmentId}:${b.environmentId}`} a={a} b={b} />
        ))}
      </SettingsSection>
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

function MachinePair(props: { readonly a: NamedEnvironment; readonly b: NamedEnvironment }) {
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

  const openSheet = (kind: RunKind) => {
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
    <View className="gap-3 p-4">
      <View className="gap-0.5">
        <MachinePairName a={a} b={b} />
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
    </View>
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
