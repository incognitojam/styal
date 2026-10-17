import type { EnvironmentId, ServerProviderHistoryRetention } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CheckIcon, CopyIcon, InfoIcon } from "lucide-react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { useRemoteOpenState } from "../../remoteOpen";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
} from "../../state/server";
import { OpenInPicker } from "../chat/OpenInPicker";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const formatDays = (days: number) => `${days} ${days === 1 ? "day" : "days"}`;

/** Provider-owned cleanup is informational; changing it belongs to the provider's settings file. */
export function ProviderHistorySettings({
  environmentId,
  retention,
}: {
  readonly environmentId: EnvironmentId | undefined;
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
                A Claude Code setting. styal shows the global value from the settings file below.
              </TooltipPopup>
            </Tooltip>
          </span>
        }
        description={description}
        status={
          retention ? (
            <SettingsFileActions
              environmentId={environmentId}
              path={retention.settingsPath}
              line={retention.line}
            />
          ) : null
        }
        control={
          retention ? (
            <div className="flex flex-col gap-0.5 sm:items-end sm:text-right">
              <span className="text-sm font-medium tabular-nums text-foreground">
                {formatDays(retention.days)}
              </span>
              {retention.status === "default" ? (
                <span className="text-xs text-muted-foreground">Claude Code default</span>
              ) : null}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">Not reported by this server</span>
          )
        }
      />
    </SettingsSection>
  );
}

/** The settings file path, plus an editor picker that opens it locally or over SSH. */
function SettingsFileActions({
  environmentId: requestedEnvironmentId,
  path,
  line,
}: {
  readonly environmentId: EnvironmentId | undefined;
  readonly path: string;
  readonly line: number | undefined;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = requestedEnvironmentId ?? primaryEnvironmentId;
  const remoteOpenState = useRemoteOpenState(environmentId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  // Matches the file preview: a local editor list only applies to the primary
  // environment; other environments open through a remote editor link.
  const canOpen =
    environmentId !== null &&
    (environmentId === primaryEnvironmentId || remoteOpenState.mode !== "local-exec");
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <SettingsPathChip path={path} copyable={!canOpen} />
      {/* The picker's menu also offers Copy path. */}
      {canOpen ? (
        <OpenInPicker
          environmentId={environmentId}
          keybindings={keybindings}
          availableEditors={availableEditors}
          openInCwd={path}
          openInLine={line}
          compact
          enableShortcut={false}
        />
      ) : null}
    </div>
  );
}

function SettingsPathChip({
  path,
  copyable,
}: {
  readonly path: string;
  readonly copyable: boolean;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const fileNameStart = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  return (
    <div
      className={cn(
        "inline-flex h-7 min-w-0 items-center gap-0.5 rounded-md border border-border/70 bg-muted/40 pl-2",
        copyable ? "pr-0.5" : "pr-2",
      )}
    >
      {/* Keep the file name visible; only the directory truncates. */}
      <code className="flex min-w-0 font-mono text-2xs text-foreground/80">
        <span className="truncate">{path.slice(0, fileNameStart)}</span>
        <span className="shrink-0">{path.slice(fileNameStart)}</span>
      </code>
      {copyable ? (
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
      ) : null}
    </div>
  );
}
