import { LINK_DEFAULT_ACCESS } from "@t3tools/client-runtime/link-request";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  planStopWorkingTogether,
  planWorkTogether,
  type WorkTogetherLine,
  type WorkTogetherMachine,
  workTogetherDefaultAccess,
  workTogetherLabels,
  workTogetherFailureMessage,
  workTogetherMissingShares,
  workTogetherOutcome,
  workTogetherSharedDevices,
  workTogetherStatus,
} from "@t3tools/client-runtime/state/workTogether";
import {
  AuthAccessWriteScope,
  type AuthMcpClientAccess,
  AuthSettingsWriteScope,
} from "@t3tools/contracts";
import { CheckIcon, CircleAlertIcon, CircleIcon, ClockIcon, MinusIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { reportForkClientUsage } from "~/forkClientUsage";
import { useDeviceState } from "../../state/device";
import { useEnvironments } from "../../state/environments";
import { peerLinkEnvironment, useLinkableMachines, workTogether } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
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
import { LinkAccessPicker } from "./LinkAccessPicker";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type Environment = ReturnType<typeof useEnvironments>["environments"][number];
type RunKind = "start" | "stop";

/** Each pair of the machines this client knows, and what it can do with them. */
export function WorkTogetherSettings() {
  const { environments } = useEnvironments();
  const machines = workTogetherLabels(
    environments.filter(
      (environment) => environment.serverConfig?.environment.capabilities.peerLinks !== false,
    ),
  );
  const pairs = machines.flatMap((a, index) =>
    machines.slice(index + 1).map((b) => [a, b] as const),
  );
  return (
    <SettingsSection id="work-together" title="Work together">
      {pairs.length === 0 ? (
        <SettingsRow
          title="Add another machine first"
          description="Add it under Environments. Your machines can then start and message threads on each other, and share simulators."
        />
      ) : (
        pairs.map(([a, b]) => (
          <MachinePair key={`${a.environmentId}:${b.environmentId}`} a={a} b={b} />
        ))
      )}
    </SettingsSection>
  );
}

function useWorkTogetherMachine(environment: Environment, other: Environment): WorkTogetherMachine {
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
    ownLabel: serverConfig?.environment.label ?? null,
    connected,
    loaded: connected && (links.data !== null || links.error !== null) && device.settled,
    canManage: mayManageAccess && mayChangeSettings,
    allowsLinks: serverConfig?.settings.linkedEnvironmentsEnabled === true,
    links: connected ? (links.data?.links ?? null) : null,
    urls: known?.urls ?? [],
    deviceUrls: addresses,
    hasDevices:
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
}: {
  readonly a: Environment;
  readonly b: Environment;
}) {
  const a = useWorkTogetherMachine(first, second);
  const b = useWorkTogetherMachine(second, first);
  const execute = useAtomCommand(workTogether, { reportFailure: false, reportDefect: false });
  const [dialog, setDialog] = useState<RunKind | null>(null);
  const [access, setAccess] = useState<AuthMcpClientAccess>(LINK_DEFAULT_ACCESS);
  const [run, setRun] = useState<Run | null>(null);
  const status = workTogetherStatus(a, b);
  const label = `${a.label} and ${b.label}`;
  const absent = [a, b].find((machine) => !machine.connected);
  const loading = [a, b].some((machine) => machine.connected && !machine.loaded);
  const missingShares = workTogetherMissingShares(a, b);
  const unmanaged = [a, b].find((machine) => machine.connected && !machine.canManage);
  const running = run !== null && !run.finished;
  const waiting =
    run !== null && run.finished && run.lines.some((line) => line.status.state === "waiting");

  const openDialog = (kind: RunKind) => {
    // A run left waiting stays on screen only for the same action.
    if (run?.kind !== kind && !running) {
      setRun(null);
      if (kind === "start") setAccess(workTogetherDefaultAccess(a, b));
    }
    setDialog(kind);
  };

  const start = async (kind: RunKind) => {
    const lines = kind === "start" ? planWorkTogether(a, b, access) : planStopWorkingTogether(a, b);
    setRun({ kind, lines, finished: false });
    const result = await execute({
      lines,
      access,
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a machine that wakes while this page is open finishes the run that was waiting for it
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the run starts on a connection change outside React
    if (waiting && bothLoaded) resume();
  }, [waiting, bothLoaded]);

  return (
    <>
      <SettingsRow
        title={label}
        status={
          status === "together"
            ? absent === undefined
              ? missingShares.length > 0
                ? `Working together · Sharing isn't set up for ${missingShares.map(({ device }) => device.label).join(" or ")}`
                : "Working together"
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
            : status === "separate"
              ? absent === undefined
                ? "Agents on each can start and message threads on the other."
                : `${absent.label} isn't connected. Start now and it finishes when ${absent.label} is back.`
              : status === "partial"
                ? "Finish setting them up, or stop to undo what's there."
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
              {status === "together" && missingShares.length === 0 ? null : (
                <Button size="xs" disabled={loading} onClick={() => openDialog("start")}>
                  {status === "separate" ? "Work together" : "Finish"}
                </Button>
              )}
            </div>
          )
        }
      />
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
            {run !== null ? (
              <WorkTogetherProgress lines={run.lines} />
            ) : dialog === "start" ? (
              <LinkAccessPicker value={access} onChange={setAccess} />
            ) : null}
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
