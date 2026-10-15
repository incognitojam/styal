import type { ConfirmDialogThreadActivity, HostActivityThread } from "@t3tools/contracts";
import { hostActivityReasonLabels } from "@t3tools/shared/hostActivity";
import {
  CircleHelpIcon,
  Clock3Icon,
  MessageSquareIcon,
  NetworkIcon,
  RadioIcon,
  ShieldCheckIcon,
  SquareTerminalIcon,
  type LucideIcon,
} from "lucide-react";

const reasonIcons: Record<HostActivityThread["reasons"][number], LucideIcon> = {
  preparing: Clock3Icon,
  starting: Clock3Icon,
  running: MessageSquareIcon,
  input: CircleHelpIcon,
  approval: ShieldCheckIcon,
  waiting: CircleHelpIcon,
  command: SquareTerminalIcon,
  monitor: RadioIcon,
  subagent: NetworkIcon,
  background_task: SquareTerminalIcon,
};

export function HostActivityThreadList({
  activity,
}: {
  readonly activity: ReadonlyArray<ConfirmDialogThreadActivity>;
}) {
  return (
    <div className="mx-6 mb-6 min-h-0 overflow-y-auto rounded-xl border border-border/70 bg-background/35">
      <ul aria-label="Affected threads" className="divide-y divide-border/60">
        {activity.map(({ thread, hostLabel, continuesAfterRestart }) => {
          const Icon = reasonIcons[thread.reasons[0] ?? "running"];
          return (
            <li className="flex gap-3 px-4 py-3.5" key={`${hostLabel ?? ""}:${thread.threadId}`}>
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
                <Icon aria-hidden="true" className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="wrap-anywhere text-sm font-medium leading-5 text-foreground">
                  {thread.title.trim() || "Untitled thread"}
                </p>
                {thread.projectTitle || hostLabel ? (
                  <p className="mt-0.5 wrap-anywhere text-xs leading-4 text-muted-foreground">
                    {thread.projectTitle}
                    {thread.projectTitle && hostLabel ? (
                      <span className="px-1.5 text-muted-foreground/50" aria-hidden="true">
                        /
                      </span>
                    ) : null}
                    {hostLabel}
                  </p>
                ) : null}
                <div className="mt-2 flex items-start gap-1.5 text-xs leading-4 text-muted-foreground">
                  <span
                    className="mt-1.5 size-1 shrink-0 rounded-full bg-warning"
                    aria-hidden="true"
                  />
                  <p>
                    {thread.reasons.map((reason) => hostActivityReasonLabels[reason]).join(", ")}
                  </p>
                </div>
                {continuesAfterRestart ? (
                  <p className="mt-1 text-xs leading-4 text-info-foreground">
                    Continues after restart
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
