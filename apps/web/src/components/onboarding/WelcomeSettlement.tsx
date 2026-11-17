import { DEFAULT_UNIFIED_SETTINGS, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import {
  AUTO_SETTLE_DEFAULT_DAYS,
  resolveSettlementPatch,
  type SettlementChoice,
} from "../../onboarding/settlement.logic";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Checkbox } from "../ui/checkbox";
import { RowIcon, WelcomeSection } from "./welcomeLayout";

/**
 * How finished threads settle on the computers being set up. The choice starts from the first
 * one's settings and is saved on Start, only to computers whose values differ; each keeps its own
 * inactivity threshold. Computers whose settings have not loaded are left out.
 */
export function useWelcomeSettlement(environmentIds: ReadonlyArray<EnvironmentId>) {
  const { environments } = useEnvironments();
  const update = useAtomCommand(serverEnvironment.updateSettings, "Save settling preferences");
  const targets = environmentIds.flatMap((environmentId) => {
    const settings = environments.find((environment) => environment.environmentId === environmentId)
      ?.serverConfig?.settings;
    return settings ? [{ environmentId, settings }] : [];
  });
  const current = targets[0]?.settings ?? DEFAULT_UNIFIED_SETTINGS;
  const [chosen, setChoice] = useState<SettlementChoice | null>(null);
  const choice = chosen ?? {
    onMerge: current.sidebarAutoSettleOnMerge,
    whenInactive: current.sidebarAutoSettleAfterDays !== null,
  };
  /** False when a save failed; its toast has been shown and the page stays for a retry. */
  const save = async () => {
    const results = await Promise.all(
      targets.map(({ environmentId, settings }) => {
        const patch = resolveSettlementPatch(settings, choice);
        return patch ? update({ environmentId, input: { patch } }) : null;
      }),
    );
    return results.every((result) => result === null || result._tag === "Success");
  };
  return {
    available: targets.length > 0,
    choice,
    setChoice,
    days: current.sidebarAutoSettleAfterDays ?? AUTO_SETTLE_DEFAULT_DAYS,
    save,
  };
}

export function WelcomeSettlementSection({
  settlement,
  disabled,
}: {
  readonly settlement: ReturnType<typeof useWelcomeSettlement>;
  readonly disabled: boolean;
}) {
  const { choice, setChoice, days } = settlement;
  return (
    <WelcomeSection title="Threads">
      <SettlementRow
        title="Settle a thread when its pull request merges"
        detail="Closed pull requests settle either way."
        checked={choice.onMerge}
        disabled={disabled}
        onCheckedChange={(onMerge) => setChoice({ ...choice, onMerge })}
      />
      <SettlementRow
        title={`Settle a thread after ${days} ${days === 1 ? "day" : "days"} without activity`}
        checked={choice.whenInactive}
        disabled={disabled}
        onCheckedChange={(whenInactive) => setChoice({ ...choice, whenInactive })}
      />
      <p className="pt-1 pl-8 text-xs leading-relaxed text-muted-foreground">
        Settling moves a finished thread to the Settled shelf at the bottom of the sidebar. The
        conversation stays, and new activity brings it back. Turn both off to settle threads only by
        hand, or change this later in Settings.
      </p>
    </WelcomeSection>
  );
}

function SettlementRow({
  title,
  detail,
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-10 cursor-pointer items-center gap-3 py-1 has-disabled:cursor-default">
      <RowIcon>
        <Checkbox
          checked={checked}
          disabled={disabled}
          onCheckedChange={(value) => onCheckedChange(value === true)}
        />
      </RowIcon>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
      </span>
    </label>
  );
}
