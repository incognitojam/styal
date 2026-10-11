import { deviceSharingErrorMessage } from "@t3tools/client-runtime/state/device";
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { deviceEnvironment, useDeviceState } from "../../state/device";
import { useEnvironments, useEnvironmentHttpBaseUrl } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
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
  const source =
    connectedEnvironments.find((entry) => entry.environmentId === sourceId) ??
    connectedEnvironments[0];
  const candidates = environments.filter(
    (entry) =>
      entry.connection.phase === "connected" && entry.environmentId !== source?.environmentId,
  );
  const target = candidates.find((entry) => entry.environmentId === targetId) ?? candidates[0];
  const url = useEnvironmentHttpBaseUrl(target?.environmentId ?? null);
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
