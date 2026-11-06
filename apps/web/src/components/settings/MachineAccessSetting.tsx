import {
  MACHINE_ACCESS_CHOICES,
  machineAccessStopNotice,
} from "@t3tools/client-runtime/link-request";
import {
  AuthAccessWriteScope,
  type EnvironmentId,
  IncomingMachineAccess,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { reportForkClientUsage } from "~/forkClientUsage";
import { cn } from "~/lib/utils";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { serverEnvironment } from "~/state/server";
import { Radio, RadioGroup } from "../ui/radio-group";
import { stackedThreadToast, toastManager } from "../ui/toast";

const isLevel = Schema.is(IncomingMachineAccess);

/** What a machine lets your other machines do there. Lowering it asks first if it stops work. */
export function MachineAccessSetting({
  environmentId,
  machineLabel,
  level,
  supported,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly level: IncomingMachineAccess;
  /** The machine runs a version that enforces this. */
  readonly supported: boolean;
}) {
  const mayChange = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const incomingWork = useAtomCommand(peerLinkEnvironment.incomingWork, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const fail = (description: string) =>
    toastManager.add(
      stackedThreadToast({ type: "error", title: "Setting not saved", description }),
    );

  const choose = async (next: IncomingMachineAccess) => {
    if (next === level) return;
    setBusy(true);
    let runningThreads = 0;
    if (next !== "everything") {
      const work = await incomingWork({ environmentId, input: {} });
      // Without a count, nobody can agree to what would stop.
      if (work._tag === "Failure") {
        setBusy(false);
        fail(`Could not check what's running on ${machineLabel}. Try again.`);
        return;
      }
      runningThreads = work.value.runningThreads;
    }
    if (runningThreads > 0) {
      const confirmed = await (requestConfirmDialog(
        machineAccessStopNotice(machineLabel, next, runningThreads),
        { variant: "destructive" },
      ) ?? Promise.resolve(false));
      if (!confirmed) {
        setBusy(false);
        return;
      }
    }
    const result = await update({
      environmentId,
      input: { patch: { incomingMachineAccess: next } },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      fail(`Could not save on ${machineLabel}. Check that it's connected, then try again.`);
      return;
    }
    void reportForkClientUsage(environmentId, {
      feature: "machine-access",
      action: "set",
      level: next,
      stoppedThreads: runningThreads > 0,
    });
  };

  const disabled = busy || !supported || !mayChange;
  return (
    <div className="space-y-2">
      <RadioGroup
        aria-label={`What your other machines can do on ${machineLabel}`}
        value={level}
        disabled={disabled}
        onValueChange={(value) => {
          if (isLevel(value)) void choose(value);
        }}
      >
        <div className="grid gap-2 sm:grid-cols-3">
          {MACHINE_ACCESS_CHOICES.map((choice) => (
            <label
              key={choice.level}
              className={cn(
                "flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border p-3",
                choice.level === level ? "border-primary bg-primary/5" : "border-border/60",
                disabled && "cursor-default opacity-60",
              )}
            >
              <Radio value={choice.level} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{choice.label}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {choice.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </RadioGroup>
      {!supported ? (
        <p className="text-xs text-muted-foreground">
          Update styal on {machineLabel} to choose this.
        </p>
      ) : !mayChange ? (
        <p className="text-xs text-muted-foreground">
          This app can't change access on {machineLabel}. Pair it again from there to manage it.
        </p>
      ) : null}
    </div>
  );
}
