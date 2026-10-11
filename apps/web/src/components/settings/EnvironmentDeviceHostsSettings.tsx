import {
  deviceSharingErrorMessage,
  isClientOnlyDeviceAddress,
  suggestDeviceSharingAddress,
} from "@t3tools/client-runtime/state/device";
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { deviceEnvironment, useDeviceState } from "../../state/device";
import { desktopNetworkAccessStateAtom } from "../../state/desktopNetworkAccess";
import {
  useEnvironments,
  useEnvironmentHttpBaseUrl,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

export function EnvironmentDeviceHostsSettings() {
  const { scope, connectedEnvironments } = useSettingsScope();
  const { environments } = useEnvironments();
  const [sourceId, setSourceId] = useState<EnvironmentId | null>(null);
  const [targetId, setTargetId] = useState<EnvironmentId | null>(null);
  // "connect" or the host ID being revoked, so each button reports only its own work.
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // An address typed for one device environment does not carry over to another.
  const [addressDraft, setAddressDraft] = useState<{
    readonly targetId: EnvironmentId;
    readonly value: string;
  } | null>(null);
  const source =
    connectedEnvironments.find((entry) => entry.environmentId === sourceId) ??
    connectedEnvironments[0];
  const candidates = environments.filter(
    (entry) =>
      entry.connection.phase === "connected" && entry.environmentId !== source?.environmentId,
  );
  const target = candidates.find((entry) => entry.environmentId === targetId) ?? candidates[0];
  const clientUrl = useEnvironmentHttpBaseUrl(target?.environmentId ?? null);
  // The desktop app reaches its own server on loopback, but knows its network addresses.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const desktopNetworkAccess = useEnvironmentQuery(
    target && target.environmentId === primaryEnvironmentId && window.desktopBridge
      ? desktopNetworkAccessStateAtom
      : null,
  );
  const suggestedUrl = suggestDeviceSharingAddress(
    clientUrl,
    desktopNetworkAccess.data?.advertisedEndpoints,
  );
  const url = (
    addressDraft && addressDraft.targetId === target?.environmentId
      ? addressDraft.value
      : (suggestedUrl ?? "")
  ).trim();
  const clientOnly = url !== "" && isClientOnlyDeviceAddress(url);
  const sourceState = useDeviceState(source?.environmentId ?? null);
  const targetState = useDeviceState(target?.environmentId ?? null);
  const connect = useAtomCommand(deviceEnvironment.connectEnvironment);
  const disconnect = useAtomCommand(deviceEnvironment.disconnectEnvironment);
  const disabled = pending !== null || scope.kind === "project" || scope.kind === "checkout";
  const existing = source?.serverConfig?.settings.environmentDeviceHosts ?? [];
  const linked = existing.some((host) => host.environmentId === target?.environmentId);
  const checked = sourceState.loaded && targetState.loaded;
  const compatible =
    checked &&
    sourceState.state.supportsEnvironmentHosts &&
    targetState.state.supportsEnvironmentHosts;
  return (
    <SettingsRow
      id="environment-device-hosts"
      title="Devices from connected environments"
      serverScoped
      settingKeys={["environmentDeviceHosts"]}
      description="Let agents use simulators and emulators on another styal environment. The connection keeps working when you close this client."
    >
      <div className="space-y-3 pt-3 pb-2">
        {!source || !target ? (
          <p className="text-sm text-muted-foreground">
            Connect two environments to share devices between them.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm">
                <span>Agents run on</span>
                <Select
                  value={source.environmentId}
                  onValueChange={setSourceId}
                  disabled={disabled}
                  items={connectedEnvironments.map((entry) => ({
                    value: entry.environmentId,
                    label: entry.label,
                  }))}
                >
                  <SelectTrigger aria-label="Agents run on">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {connectedEnvironments.map((entry) => (
                      <SelectItem key={entry.environmentId} value={entry.environmentId}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              <label className="space-y-1.5 text-sm">
                <span>Use devices from</span>
                <Select
                  value={target.environmentId}
                  onValueChange={setTargetId}
                  disabled={disabled}
                  items={candidates.map((entry) => ({
                    value: entry.environmentId,
                    label: entry.label,
                  }))}
                >
                  <SelectTrigger aria-label="Use devices from">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {candidates.map((entry) => (
                      <SelectItem key={entry.environmentId} value={entry.environmentId}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
            </div>
            <label className="block space-y-1.5 text-sm">
              <span>
                Address {source.label} uses to reach {target.label}
              </span>
              <Input
                value={url}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
                aria-label={`Address ${source.label} uses to reach ${target.label}`}
                onChange={(event) =>
                  setAddressDraft({ targetId: target.environmentId, value: event.target.value })
                }
              />
            </label>
            {clientOnly ? (
              <p className="text-sm text-muted-foreground">
                This address only works if {source.label} runs on the same machine as {target.label}
                . Otherwise enter a LAN, Tailscale, or styal Link address for {target.label}.
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              {!checked
                ? "Checking whether both environments support device sharing…"
                : compatible
                  ? `${source.label} agents will be allowed to control devices on ${target.label}. Device hub and agent access will be enabled on both.`
                  : "Update both environments to a version that supports device sharing."}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !url || !compatible}
              onClick={() => {
                if (!url) return;
                setError(null);
                setPending("connect");
                void connect({
                  environmentId: source.environmentId,
                  input: {
                    targetEnvironmentId: target.environmentId,
                    targetLabel: target.label,
                    url,
                    sourceLabel: source.label,
                  },
                })
                  .then((result) => {
                    if (result._tag === "Failure")
                      setError(deviceSharingErrorMessage(result.cause));
                  })
                  .finally(() => setPending(null));
              }}
            >
              {pending === "connect"
                ? "Connecting…"
                : linked
                  ? "Reconnect device access"
                  : "Allow device access"}
            </Button>
          </>
        )}
        {error ? (
          <p role="status" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {connectedEnvironments.map((environment) =>
          (environment.serverConfig?.settings.environmentDeviceHosts ?? []).map((host) => (
            <div
              key={`${environment.environmentId}:${host.id}`}
              className="flex items-center gap-3 border-t border-border/50 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{host.label}</p>
                <p className="text-xs text-muted-foreground">
                  Available to agents on {environment.label}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  setError(null);
                  setPending(host.id);
                  void disconnect({
                    environmentId: environment.environmentId,
                    input: { hostId: host.id },
                  })
                    .then((result) => {
                      if (result._tag === "Failure")
                        setError(deviceSharingErrorMessage(result.cause));
                    })
                    .finally(() => setPending(null));
                }}
              >
                {pending === host.id ? "Revoking…" : "Revoke access"}
              </Button>
            </div>
          )),
        )}
      </div>
    </SettingsRow>
  );
}
