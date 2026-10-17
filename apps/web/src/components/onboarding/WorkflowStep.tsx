import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { ArrowRightIcon, CircleCheckIcon } from "lucide-react";
import { useState } from "react";

import { reportForkClientUsage } from "../../forkClientUsage";
import { cn } from "../../lib/utils";
import {
  AUTO_SETTLE_DEFAULT_DAYS,
  resolveSettlementPatch,
} from "../../onboarding/settlement.logic";
import type { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

type SettlementEnvironment = ReturnType<typeof useEnvironments>["environments"][number];

/**
 * Opinionated defaults for how styal handles work, shown once before setup lands in the sidebar.
 * Today it explains settling and offers its two automatic rules.
 * Choices apply to every selected computer; each keeps its own inactivity threshold.
 */
export function WorkflowStep({
  environments,
  onContinue,
}: {
  readonly environments: readonly SettlementEnvironment[];
  readonly onContinue: () => Promise<boolean>;
}) {
  const update = useAtomCommand(serverEnvironment.updateSettings, "Save settling preferences");
  const current = environments[0]?.serverConfig?.settings ?? DEFAULT_UNIFIED_SETTINGS;
  const days = current.sidebarAutoSettleAfterDays ?? AUTO_SETTLE_DEFAULT_DAYS;
  const [onMerge, setOnMerge] = useState(current.sidebarAutoSettleOnMerge);
  const [whenInactive, setWhenInactive] = useState(current.sidebarAutoSettleAfterDays !== null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    const results = await Promise.all(
      environments.map((environment) => {
        const settings = environment.serverConfig?.settings;
        const patch = settings ? resolveSettlementPatch(settings, { onMerge, whenInactive }) : null;
        return patch
          ? update({ environmentId: environment.environmentId, input: { patch } })
          : null;
      }),
    );
    // A failed save has already raised its toast; stay so the user can retry.
    if (results.some((result) => result !== null && result._tag !== "Success")) {
      setSaving(false);
      return;
    }
    void reportForkClientUsage(environments[0]?.environmentId, {
      feature: "setup-thread-settlement",
      action: "continued",
      settleOnMerge: onMerge,
      settleWhenInactive: whenInactive,
    });
    await onContinue().finally(() => setSaving(false));
  };

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Workflow</h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        A few defaults for how styal handles your work. Change them any time in Settings → General.
      </p>
      <h2 className="mt-6 text-base font-semibold text-foreground">Settling finished threads</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        Settling moves a finished thread out of your active list into the Settled shelf at the
        bottom of the sidebar. The conversation stays, and new activity brings it back.
      </p>
      <div
        aria-hidden
        className="mt-4 grid gap-1 rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground"
      >
        <SettlingPreviewRow label="Add billing export" />
        <SettlingPreviewRow label="Fix flaky login test" />
        <div className="mt-2 flex items-center gap-1.5 px-2 text-2xs font-medium tracking-wide uppercase text-muted-foreground/80">
          <CircleCheckIcon className="size-3" />
          Settled
        </div>
        <SettlingPreviewRow label="Migrate config loader" settled />
      </div>
      <div className="mt-5 divide-y divide-border/60 rounded-lg border border-border/60">
        <label className="flex cursor-pointer items-center justify-between gap-4 p-3">
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              When its pull request merges
            </span>
            <span className="block text-xs leading-normal text-muted-foreground">
              Closed pull requests settle either way.
            </span>
          </span>
          <Switch
            checked={onMerge}
            onCheckedChange={(checked) => setOnMerge(Boolean(checked))}
            disabled={saving}
          />
        </label>
        <label className="flex cursor-pointer items-center justify-between gap-4 p-3">
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              After {days} {days === 1 ? "day" : "days"} without activity
            </span>
          </span>
          <Switch
            checked={whenInactive}
            onCheckedChange={(checked) => setWhenInactive(Boolean(checked))}
            disabled={saving}
          />
        </label>
      </div>
      <p className="mt-3 text-xs leading-normal text-muted-foreground">
        Turn both off to settle threads only by hand.
      </p>
      <div className="mt-6 flex justify-end">
        <Button autoFocus onClick={() => void save()} disabled={saving}>
          {saving ? "Finishing…" : "Finish"}
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </>
  );
}

function SettlingPreviewRow({ label, settled = false }: { label: string; settled?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5",
        settled ? "text-muted-foreground/70" : "bg-background/60 text-foreground",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {settled ? (
        <span className="flex shrink-0 items-center gap-1 text-2xs">
          <PullRequestGlyph.merged className="size-3" />
          Merged
        </span>
      ) : null}
    </div>
  );
}
