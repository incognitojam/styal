import { DeviceToolVersions } from "../device/DeviceToolVersions";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { AppleIcon, AndroidIcon } from "../Icons";
import { Spinner } from "../ui/spinner";
import type { EnvironmentId, SshDeviceHostConfig } from "@t3tools/contracts";
import { useState } from "react";
import { deviceEnvironment, useDeviceState } from "../../state/device";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { MoreVertical } from "lucide-react";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { SettingsRow } from "./settingsLayout";

import { useSettingsScope } from "./SettingsScopeContext";
import { toastManager } from "../ui/toast";
import { updateDeviceHosts } from "./deviceHostsSettings.logic";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { DeviceHostEditor } from "./DeviceHostEditor";
import { useHostConnectionChecks } from "./useHostConnectionChecks";
import { deviceHostConnectionKey } from "./deviceHostConnectionChecks";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";

export function DeviceHostsSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const { environment } = useSettingsScope();
  const canConfigure = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const [editing, setEditing] = useState<SshDeviceHostConfig | null>(null);
  const [originalHost, setOriginalHost] = useState<SshDeviceHostConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const targets = environment
    ? [
        {
          environmentId,
          label: settingsScopeEnvironmentLabel(environment, [environment]),
          connected: true,
        },
      ]
    : [];
  const { checks, testConnection } = useHostConnectionChecks(targets);
  const hosts = environment?.serverConfig?.settings.deviceHosts ?? [];
  if (hosts.length === 0) return null;

  const save = async (host: SshDeviceHostConfig, remove = false, original = host) => {
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return;
    const deviceHosts = updateDeviceHosts(hosts, host, remove, original);
    if (deviceHosts === hosts) return;
    setBusy(true);
    const result = await update({ environmentId, input: { patch: { deviceHosts } } }).finally(() =>
      setBusy(false),
    );
    if (result._tag !== "Failure") setEditing(null);
  };
  return (
    <FoldedSettingsSection id={`device-hosts-${environmentId}`} title="Existing SSH device hosts">
      <SettingsRow
        id={`saved-device-hosts-${environmentId}`}
        title="Saved hosts"
        serverScoped
        settingKeys={["deviceHosts"]}
        description="Manage existing SSH connections. To use devices from another machine, connect its environment and share its devices above."
      >
        <div className="pt-3 pb-2">
          <DeviceHostList
            environmentId={environmentId}
            hosts={hosts}
            busy={!canConfigure || busy}
            checks={checks}
            testConnection={async (host) => {
              const results = await testConnection(host);
              if (!results) return;
              const failed = results[environmentId]?.status === "failed";
              toastManager.add({
                type: failed ? "error" : "success",
                title: `${host.label}: ${failed ? "connection check failed" : "connection check passed"}`,
              });
              return results;
            }}
            onEdit={(host) => {
              setOriginalHost(host);
              setEditing(host);
            }}
            onRemove={(host) => void save(host, true)}
          />
          {editing ? (
            <DeviceHostEditor
              key={editing.id}
              host={editing}
              isNew={false}
              targets={targets}
              busy={busy}
              onSave={(host) => void save(host, false, originalHost ?? host)}
              onClose={() => setEditing(null)}
            />
          ) : null}
        </div>
      </SettingsRow>
    </FoldedSettingsSection>
  );
}

function DeviceHostList({
  environmentId,
  hosts,
  busy,
  onEdit,
  onRemove,
  checks,
  testConnection,
}: {
  environmentId: EnvironmentId;
  hosts: ReadonlyArray<SshDeviceHostConfig>;
  busy: boolean;
  onEdit: (host: SshDeviceHostConfig) => void;
  onRemove: (host: SshDeviceHostConfig) => void;
  checks: ReturnType<typeof useHostConnectionChecks>["checks"];
  testConnection: ReturnType<typeof useHostConnectionChecks>["testConnection"];
}) {
  const { state } = useDeviceState(environmentId);
  const retry = useAtomCommand(deviceEnvironment.list);
  const [retrying, setRetrying] = useState<string | null>(null);
  return hosts.map((host) => {
    const status = state.hostStatuses[host.id];
    const check = checks[deviceHostConnectionKey(host)]?.[environmentId];
    const summary = state.hosts.find((value) => value.id === host.id);
    const error =
      check?.status === "failed"
        ? check.error
        : check?.status !== "local" && status?.status === "failed"
          ? status.detail
          : undefined;
    const platforms =
      (check?.status === "connected" ? check.platforms : undefined) ?? summary?.platforms ?? [];
    const progress =
      check?.status === "pending"
        ? "Checking connection…"
        : status?.status === "installing"
          ? "Installing device support…"
          : status?.status === "starting"
            ? "Connecting…"
            : null;
    const canRetry =
      status?.status === "failed" && state.supportsHostRetry && state.hostStatus !== "disabled";
    return (
      <div key={host.id} className="flex items-center gap-2 border-t border-border/50 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-medium">{host.label}</p>
            {platforms
              .filter((platform) => platform.available)
              .map((platform) => (
                <Tooltip key={platform.platform}>
                  <TooltipTrigger
                    render={
                      <span
                        tabIndex={0}
                        role="img"
                        aria-label={
                          platform.platform === "ios" ? "iOS available" : "Android available"
                        }
                        className="shrink-0 text-muted-foreground"
                      />
                    }
                  >
                    {platform.platform === "ios" ? (
                      <AppleIcon className="size-3.5 -translate-y-px" />
                    ) : (
                      <AndroidIcon className="size-3.5" />
                    )}
                  </TooltipTrigger>
                  <TooltipPopup>
                    {platform.platform === "ios" ? "iOS available" : "Android available"}
                  </TooltipPopup>
                </Tooltip>
              ))}
          </div>
          <p className="truncate text-xs text-muted-foreground">{host.target}</p>
          {status?.status === "ready" && status.androidDiscoveryIncomplete ? (
            <p role="status" className="mt-1 text-xs text-warning">
              {status.detail ??
                "The Android device list may be incomplete. Refresh devices to try again."}
            </p>
          ) : null}
          <DeviceToolVersions
            error={summary?.toolInspectionError}
            tools={summary?.tools ?? (check?.status === "connected" ? check.tools : undefined)}
          />
          {check?.status === "local" ? (
            <p className="mt-1 text-xs text-muted-foreground">Already available locally</p>
          ) : null}
          {error ? (
            <div className="mt-1" role="status">
              <details className="text-xs text-destructive">
                <summary>Connection failed</summary>
                <p className="mt-1 whitespace-pre-wrap break-words">{error}</p>
              </details>
            </div>
          ) : null}
        </div>
        {progress ? (
          <span
            role="status"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <Spinner size="xs" />
            {progress}
          </span>
        ) : null}
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost-muted"
                disabled={busy}
                aria-label={host.label + " options"}
              />
            }
          >
            <MoreVertical />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => onEdit(host)}>Edit</MenuItem>
            <MenuItem variant="destructive" onClick={() => onRemove(host)}>
              Remove
            </MenuItem>
          </MenuPopup>
        </Menu>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || (canRetry ? retrying !== null : progress !== null)}
          onClick={() => {
            if (canRetry) {
              setRetrying(host.id);
              void retry({ environmentId, input: { retryHostId: host.id } }).finally(() =>
                setRetrying(null),
              );
            } else void testConnection(host);
          }}
        >
          {canRetry ? (retrying === host.id ? "Retrying…" : "Retry") : "Test connection"}
        </Button>
      </div>
    );
  });
}
