import type { ServerProviderHistoryRetention } from "@t3tools/contracts";
import { CheckIcon, CopyIcon, InfoIcon } from "lucide-react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const formatDays = (days: number) => `${days} ${days === 1 ? "day" : "days"}`;

/** Provider-owned cleanup is informational; changing it belongs to the provider's settings file. */
export function ProviderHistorySettings({
  retention,
}: {
  readonly retention: ServerProviderHistoryRetention | undefined;
}) {
  const description = (
    <>
      Claude Code deletes older session files. Their costs then drop out of styal's usage history.
      {retention?.status === "default" ? (
        <>
          {" "}
          Set <code className="text-foreground/80">cleanupPeriodDays</code> to keep them longer.
        </>
      ) : null}
    </>
  );

  return (
    <SettingsSection title="History">
      <SettingsRow
        title={
          <span className="inline-flex items-center gap-1">
            Session retention
            <Tooltip>
              <TooltipTrigger
                delay={200}
                render={
                  <Button size="icon-micro" variant="ghost-muted" aria-label="Retention details">
                    <InfoIcon className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup side="top" className="max-w-72">
                Read from your user settings. Project, managed, and session settings can override
                it. Refresh provider status after editing the file.
              </TooltipPopup>
            </Tooltip>
          </span>
        }
        description={description}
        status={retention ? <SettingsPathChip path={retention.settingsPath} /> : null}
        control={
          retention ? (
            <div className="flex flex-col gap-0.5 sm:items-end sm:text-right">
              <span className="text-sm font-medium tabular-nums text-foreground">
                {formatDays(retention.days)}
              </span>
              <span className="text-xs text-muted-foreground">
                {retention.status === "default" ? "Claude Code default" : "Your setting"}
              </span>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">Not reported by this server</span>
          )
        }
      />
    </SettingsSection>
  );
}

function SettingsPathChip({ path }: { readonly path: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const fileNameStart = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  return (
    <div className="inline-flex max-w-full min-w-0 items-center gap-0.5 rounded-md border border-border/70 bg-muted/40 py-0.5 pr-0.5 pl-2">
      {/* Keep the file name visible; only the directory truncates. */}
      <code className="flex min-w-0 font-mono text-2xs text-foreground/80">
        <span className="truncate">{path.slice(0, fileNameStart)}</span>
        <span className="shrink-0">{path.slice(fileNameStart)}</span>
      </code>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              className="shrink-0"
              onClick={() => copyToClipboard(path)}
              aria-label="Copy settings file path"
            >
              {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </Button>
          }
        />
        <TooltipPopup side="top" className="max-w-96 break-all">
          {isCopied ? "Copied" : `Copy ${path}`}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
