import { useAtomValue } from "@effect/atom-react";
/**
 * Mounting the device list subscribes to hardware state, which makes the server probe device
 * health, so nothing here is rendered off this page.
 *
 * @module HardwareSettings
 */
import {
  hardwareAuditDetailSummary,
  hardwareLeaseExpiryLabel,
  updateHardwareDevices,
} from "@t3tools/client-runtime/state/hardware";
import {
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  HARDWARE_DEFINITION_DIRECTORY,
  type EnvironmentId,
  type HardwareDeviceConfig,
  type HardwareDeviceState,
  type HardwareTier,
  type ProjectId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MoreVertical, PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { useProjects, useThreadShell } from "~/state/entities";
import { hardwareEnvironment, useHardwareState } from "~/state/hardware";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { RelativeTime } from "../RelativeTime";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { reportHardwareResult } from "../hardware/reportHardwareResult";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
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
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { toastManager } from "../ui/toast";
import {
  EMPTY_HARDWARE_DEVICE_DRAFT,
  hardwareDefinitionChangeLabel,
  hardwareDeviceDraftFromConfig,
  hardwareHealthLine,
  parseHardwareDeviceDraft,
  type HardwareDeviceDraft,
  type HardwareDeviceDraftField,
} from "./hardwareSettings.logic";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const RELATIVE_TICK_MS = 30_000;

const HEALTH_DOT_CLASS: Readonly<Record<HardwareDeviceState["health"]["status"], string>> = {
  online: "bg-success",
  offline: "bg-destructive",
  unknown: "bg-muted-foreground/40",
};

const TIER_LABELS: Readonly<Record<HardwareTier, string>> = {
  read: "Read",
  operate: "Operate",
  approve: "Needs approval",
};

export function HardwareSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection id="hardware-access" title="Agents">
        <AgentHardwareAccessSetting />
      </SettingsSection>
      <HardwareDevicesSection />
    </SettingsPageContainer>
  );
}

function AgentHardwareAccessSetting() {
  const { scope } = useSettingsScope();
  const enabled = useScopedSettings((settings) => settings.enableAgentHardwareAccess);
  const updateSettings = useUpdateScopedSettings();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  return (
    <SettingsRow
      {...searchableSetting("agent-hardware-access")}
      serverScoped
      settingKeys={["enableAgentHardwareAccess"]}
      description={
        projectScope
          ? "Allow agents in this project to lease and call its hardware. Applies when the agent session next starts."
          : "Allow agents to lease and call hardware their project owns. Projects can override it."
      }
      resetAction={
        enabled !== DEFAULT_SERVER_SETTINGS.enableAgentHardwareAccess ? (
          <SettingResetButton
            label="agent hardware access"
            onClick={() =>
              updateSettings({
                enableAgentHardwareAccess: DEFAULT_SERVER_SETTINGS.enableAgentHardwareAccess,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["enableAgentHardwareAccess"]}
          aria-label="Agent hardware access"
          checked={enabled}
          onCheckedChange={(checked) =>
            updateSettings({ enableAgentHardwareAccess: Boolean(checked) })
          }
        />
      }
    />
  );
}

function HardwareDevicesSection() {
  const { scope, connectedEnvironments } = useSettingsScope();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  // A project selection narrows the list to devices whose definition lives in it.
  const scopedProjectIds = projectScope
    ? new Set(scope.members.map((member) => `${member.environmentId}:${member.id}`))
    : null;
  return (
    <SettingsSection id="hardware-devices-section" title="Devices">
      {connectedEnvironments.length === 0 ? (
        <SettingsRow
          {...searchableSetting("hardware-devices")}
          description="Connect a selected environment to manage its hardware."
        />
      ) : (
        connectedEnvironments.map((environment, index) => (
          <EnvironmentHardwareDevices
            key={environment.environmentId}
            anchor={index === 0}
            environmentId={environment.environmentId}
            environmentLabel={connectedEnvironments.length > 1 ? environment.label : null}
            devices={environment.serverConfig?.settings.hardwareDevices ?? []}
            visible={(device) =>
              scopedProjectIds === null ||
              scopedProjectIds.has(`${environment.environmentId}:${device.projectId}`)
            }
          />
        ))
      )}
    </SettingsSection>
  );
}

function EnvironmentHardwareDevices({
  anchor,
  environmentId,
  environmentLabel,
  devices,
  visible,
}: {
  anchor: boolean;
  environmentId: EnvironmentId;
  environmentLabel: string | null;
  devices: ReadonlyArray<HardwareDeviceConfig>;
  visible: (device: HardwareDeviceConfig) => boolean;
}) {
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const { state, loaded, error } = useHardwareState(environmentId, { probeHealth: true });
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [editing, setEditing] = useState<{ original: HardwareDeviceConfig | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const nowMs = useRelativeTimeTick(RELATIVE_TICK_MS);
  const shown = devices.filter(visible);

  const save = async (
    device: HardwareDeviceConfig,
    options: { originalId?: string; remove?: boolean },
  ) => {
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return false;
    setBusy(true);
    const result = await update({
      environmentId,
      input: { patch: { hardwareDevices: updateHardwareDevices(devices, device, options) } },
    });
    setBusy(false);
    return reportHardwareResult(
      result,
      options.remove ? `Could not remove ${device.id}` : `Could not save ${device.id}`,
    );
  };

  return (
    <SettingsRow
      id={anchor ? searchableSetting("hardware-devices").id : undefined}
      title={environmentLabel ?? "Hardware devices"}
      serverScoped
      settingKeys={["hardwareDevices"]}
      description={`Devices this environment can reach on its network. Each one's actions come from a definition file under ${HARDWARE_DEFINITION_DIRECTORY}/ on its project's default branch.`}
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={!canWrite || busy || editing !== null}
          onClick={() => setEditing({ original: null })}
        >
          <PlusIcon className="size-3.5" /> Add device
        </Button>
      }
    >
      <div className="pt-3 pb-2">
        {shown.length === 0 ? (
          <p className="border-t border-border/50 py-2.5 text-sm text-muted-foreground">
            No hardware devices.
          </p>
        ) : null}
        {error && !loaded ? (
          <p role="alert" className="py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {shown.map((config) => (
          <HardwareDeviceRow
            key={config.id}
            environmentId={environmentId}
            config={config}
            state={state.devices.find((device) => device.id === config.id) ?? null}
            loaded={loaded}
            nowMs={nowMs}
            busy={busy}
            onEdit={() => setEditing({ original: config })}
            onRemove={() => void save(config, { remove: true })}
          />
        ))}
        {editing ? (
          <HardwareDeviceEditor
            environmentId={environmentId}
            original={editing.original}
            takenIds={devices
              .map((device) => device.id)
              .filter((id) => id !== editing.original?.id)}
            busy={busy}
            onClose={() => setEditing(null)}
            onSave={async (device) => {
              const saved = await save(
                device,
                editing.original ? { originalId: editing.original.id } : {},
              );
              if (saved) setEditing(null);
            }}
          />
        ) : null}
      </div>
    </SettingsRow>
  );
}

function HardwareDeviceRow({
  environmentId,
  config,
  state,
  loaded,
  nowMs,
  busy,
  onEdit,
  onRemove,
}: {
  environmentId: EnvironmentId;
  config: HardwareDeviceConfig;
  state: HardwareDeviceState | null;
  loaded: boolean;
  nowMs: number;
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const canOperate = useAtomValue(hardwareEnvironment.control.permissionAtom(environmentId));
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const control = useAtomCommand(hardwareEnvironment.control, { reportFailure: false });
  const [pending, setPending] = useState<"pause" | "revoke" | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const name = state?.name || config.id;
  const lease = state?.lease ?? null;

  const run = async (
    kind: NonNullable<typeof pending>,
    input: Parameters<typeof control>[0]["input"],
    failureTitle: string,
  ) => {
    setPending(kind);
    const result = await control({ environmentId, input });
    setPending(null);
    return reportHardwareResult(result, failureTitle);
  };

  return (
    <div className="border-t border-border/50 py-2.5">
      <div className="flex items-start gap-2">
        <div className="pt-1">
          <ConnectionStatusDot
            dotClassName={HEALTH_DOT_CLASS[state?.health.status ?? "unknown"]}
            tooltipText={state ? `Health: ${state.health.status}` : null}
          />
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-medium">{name}</p>
            {name !== config.id ? (
              <span className="truncate font-mono text-xs text-muted-foreground">{config.id}</span>
            ) : null}
            {state?.paused ? <Badge variant="warning">Paused</Badge> : null}
            {state?.definition.status === "pending" ? (
              <Badge variant="info">Review definition</Badge>
            ) : state?.definition.status === "missing" || state?.definition.status === "invalid" ? (
              <Badge variant="error">No definition</Badge>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {state
              ? hardwareHealthLine(state.health, (iso) => formatRelativeTimeLabel(iso, nowMs))
              : loaded
                ? "Waiting for the server…"
                : "Loading…"}
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground">{config.baseUrl}</p>
          {lease ? (
            <HardwareHolderLine
              environmentId={environmentId}
              threadId={lease.threadId}
              purpose={lease.purpose}
              expiry={hardwareLeaseExpiryLabel(lease, nowMs)}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              {state?.cleaningUp ? "Running the last lease's release steps" : "Free"}
            </p>
          )}
          {state && state.queue.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {state.queue.length === 1
                ? "1 thread waiting"
                : `${state.queue.length} threads waiting`}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {lease ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={!canOperate || pending !== null}
              onClick={() => setConfirmRevoke(true)}
            >
              Revoke
            </Button>
          ) : null}
          {state ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canOperate || pending !== null}
              onClick={() =>
                void run(
                  "pause",
                  { type: "set-paused", deviceId: config.id, paused: !state.paused },
                  state.paused ? `Could not resume ${name}` : `Could not pause ${name}`,
                )
              }
            >
              {state.paused ? "Resume" : "Pause"}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Hide details" : "Details"}
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  disabled={!canWrite || busy}
                  aria-label={`${name} options`}
                />
              }
            >
              <MoreVertical />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={onEdit}>Edit</MenuItem>
              <MenuItem variant="destructive" onClick={() => setConfirmRemove(true)}>
                Remove
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
      {expanded && state ? (
        <div className="mt-3 ml-5 space-y-4">
          <HardwareDefinitionStatus environmentId={environmentId} config={config} state={state} />
          <HardwareCredential environmentId={environmentId} config={config} state={state} />
          <HardwareActionsTable state={state} />
          <HardwareActivity environmentId={environmentId} state={state} />
        </div>
      ) : null}
      <AlertDialog
        open={confirmRevoke}
        onOpenChange={(open) => {
          if (!open && pending !== "revoke") setConfirmRevoke(false);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The thread holding it can no longer change the device, though anyone may still read
              its status. Its release steps run to put it back; if the device does not answer, they
              keep retrying for a few minutes. The next waiting thread gets it once they finish.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={pending === "revoke"}
              render={<Button variant="outline" disabled={pending === "revoke"} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={pending === "revoke"}
              onClick={() =>
                void run(
                  "revoke",
                  { type: "revoke", deviceId: config.id },
                  `Could not revoke ${name}`,
                ).then((ok) => {
                  if (ok) setConfirmRevoke(false);
                })
              }
            >
              {pending === "revoke" ? "Revoking…" : "Revoke"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents can no longer use it, and any lease on it ends. The definition file in the
              repository stays.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirmRemove(false);
                onRemove();
              }}
            >
              Remove device
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function HardwareThreadLink({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: HardwareDeviceState["queue"][number]["threadId"];
}) {
  const shell = useThreadShell({ environmentId, threadId });
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId }}
      className="font-medium text-foreground underline underline-offset-2"
    >
      {shell?.title?.trim() || "a thread"}
    </Link>
  );
}

function HardwareHolderLine({
  environmentId,
  threadId,
  purpose,
  expiry,
}: {
  environmentId: EnvironmentId;
  threadId: HardwareDeviceState["queue"][number]["threadId"];
  purpose: string;
  expiry: string;
}) {
  return (
    <div className="text-xs text-muted-foreground">
      <p className="truncate">
        Held by <HardwareThreadLink environmentId={environmentId} threadId={threadId} />
        {purpose ? ` for “${purpose}”` : ""}
      </p>
      <p className="truncate">{expiry}</p>
    </div>
  );
}

function HardwareDefinitionStatus({
  environmentId,
  config,
  state,
}: {
  environmentId: EnvironmentId;
  config: HardwareDeviceConfig;
  state: HardwareDeviceState;
}) {
  const canWrite = useAtomValue(hardwareEnvironment.configure.permissionAtom(environmentId));
  const configure = useAtomCommand(hardwareEnvironment.configure, { reportFailure: false });
  const [accepting, setAccepting] = useState(false);
  const { definition } = state;
  const source = definition.source ?? "the default branch";
  const file = `${HARDWARE_DEFINITION_DIRECTORY}/${config.definitionFile}`;
  const firstReview = config.acceptedDefinition === undefined;
  const accept = async () => {
    setAccepting(true);
    const result = await configure({
      environmentId,
      input: { type: "accept-definition", deviceId: config.id },
    });
    setAccepting(false);
    if (reportHardwareResult(result, "Could not accept the definition"))
      toastManager.add({ type: "success", title: `${state.name || config.id} updated` });
  };
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-medium text-foreground">Definition</h4>
      {definition.status === "ok" ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-mono">{file}</span> on {source} matches what you accepted.
        </p>
      ) : definition.status === "pending" ? (
        <>
          <p className="text-xs text-muted-foreground">
            {firstReview ? (
              <>
                Review and accept the definition in <span className="font-mono">{file}</span> on{" "}
                {source}. Until you do, every action needs your approval and no hooks run.
              </>
            ) : (
              <>
                <span className="font-mono">{file}</span> on {source} has changes that wait for you.
                The rules you accepted apply until then.
              </>
            )}
          </p>
          {definition.pendingChanges.length > 0 ? (
            <ul className="space-y-0.5 text-xs">
              {definition.pendingChanges.map((change) => (
                <li key={`${change.action}:${change.kind}`} className="font-mono">
                  {firstReview && change.kind === "added"
                    ? `${change.action}${change.to ? `: ${change.to}` : ""}`
                    : hardwareDefinitionChangeLabel(change)}
                </li>
              ))}
            </ul>
          ) : null}
          <Button
            size="xs"
            variant={firstReview ? "default" : "outline"}
            disabled={!canWrite || accepting}
            onClick={() => void accept()}
          >
            {accepting ? "Accepting…" : firstReview ? "Accept definition" : "Accept changes"}
          </Button>
        </>
      ) : (
        <p className="text-xs text-destructive">
          {definition.status === "missing"
            ? `No definition at ${file} on ${source}.`
            : `The definition at ${file} on ${source} is invalid.`}
          {definition.error ? ` ${definition.error}` : ""}
        </p>
      )}
    </div>
  );
}

function HardwareCredential({
  environmentId,
  config,
  state,
}: {
  environmentId: EnvironmentId;
  config: HardwareDeviceConfig;
  state: HardwareDeviceState;
}) {
  const canWrite = useAtomValue(hardwareEnvironment.configure.permissionAtom(environmentId));
  const configure = useAtomCommand(hardwareEnvironment.configure, { reportFailure: false });
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const header = config.auth?.header ?? "Authorization";
  const setCredential = async (next: string | null) => {
    setSaving(true);
    const result = await configure({
      environmentId,
      input: { type: "set-credential", deviceId: config.id, value: next },
    });
    setSaving(false);
    const ok = reportHardwareResult(
      result,
      next === null ? "Could not clear the credential" : "Could not save the credential",
    );
    if (ok) setValue("");
  };
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-medium text-foreground">Credential</h4>
      <p className="text-xs text-muted-foreground">
        {state.hasCredential
          ? `Set. Sent in the ${header} header${config.auth?.scheme ? ` as ${config.auth.scheme} …` : ""}.`
          : `Not set. When set, it is sent in the ${header} header.`}{" "}
        Agents never see it.
      </p>
      <form
        className="flex max-w-md items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (value) void setCredential(value);
        }}
      >
        <Input
          type="password"
          size="sm"
          autoComplete="off"
          aria-label={`${state.name || config.id} credential`}
          placeholder={state.hasCredential ? "Replace credential" : "Token or password"}
          value={value}
          disabled={!canWrite || saving}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" size="xs" variant="outline" disabled={!canWrite || saving || !value}>
          Save
        </Button>
        {state.hasCredential ? (
          <Button
            type="button"
            size="xs"
            variant="ghost-destructive"
            disabled={!canWrite || saving}
            onClick={() => void setCredential(null)}
          >
            Clear
          </Button>
        ) : null}
      </form>
    </div>
  );
}

function HardwareActionsTable({ state }: { state: HardwareDeviceState }) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-medium text-foreground">Actions</h4>
      {state.actions.length === 0 ? (
        <p className="text-xs text-muted-foreground">No actions available.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Action</TableHead>
              <TableHead>Request</TableHead>
              <TableHead>Access</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.actions.map((action) => (
              <TableRow key={action.name}>
                <TableCell>
                  <span className="font-mono">{action.name}</span>
                  {action.description ? (
                    <span className="block text-muted-foreground">{action.description}</span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <span className="font-mono text-muted-foreground">
                    {action.method} {action.path}
                  </span>
                </TableCell>
                <TableCell>{TIER_LABELS[action.tier]}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

const AUDIT_LIMIT = 50;

function HardwareActivity({
  environmentId,
  state,
}: {
  environmentId: EnvironmentId;
  state: HardwareDeviceState;
}) {
  const query = useEnvironmentQuery(
    hardwareEnvironment.auditList({
      environmentId,
      input: { deviceId: state.id, limit: AUDIT_LIMIT },
    }),
  );
  // Snapshots change when a lease starts, ends, is touched by a call, or the
  // device is paused; each of those writes audit rows worth showing.
  const activityKey = [
    state.lease?.threadId,
    state.lease?.lastActivityAt,
    state.lease?.keepUntilReleased,
    state.paused,
    state.queue.length,
    state.definition.status,
  ].join("|");
  const { refresh } = query;
  const seenKey = useRef(activityKey);
  useEffect(() => {
    if (seenKey.current === activityKey) return;
    seenKey.current = activityKey;
    refresh();
  }, [activityKey, refresh]);
  const entries = query.data?.entries ?? [];
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-foreground">Recent activity</h4>
        <Button size="xs" variant="ghost-muted" disabled={query.isPending} onClick={refresh}>
          Refresh
        </Button>
      </div>
      {query.error ? (
        <p role="alert" className="text-xs text-destructive">
          {query.error}
        </p>
      ) : query.data === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing yet.</p>
      ) : (
        <ul className="divide-y divide-border/40 text-xs">
          {entries.map((entry) => {
            const detail = hardwareAuditDetailSummary(entry);
            return (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5">
                <time
                  dateTime={entry.lastOccurredAt}
                  className="w-16 shrink-0 text-muted-foreground tabular-nums"
                >
                  <RelativeTime timestamp={entry.lastOccurredAt} />
                </time>
                <span className="font-mono">{entry.event}</span>
                {entry.action ? <span className="font-mono">{entry.action}</span> : null}
                {entry.repeatCount > 1 ? (
                  <span className="text-muted-foreground tabular-nums">×{entry.repeatCount}</span>
                ) : null}
                <span className="text-muted-foreground">
                  {entry.threadId ? (
                    <HardwareThreadLink environmentId={environmentId} threadId={entry.threadId} />
                  ) : (
                    entry.actor
                  )}
                </span>
                {detail ? <span className="min-w-0 text-muted-foreground">{detail}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function HardwareDeviceEditor({
  environmentId,
  original,
  takenIds,
  busy,
  onClose,
  onSave,
}: {
  environmentId: EnvironmentId;
  original: HardwareDeviceConfig | null;
  takenIds: ReadonlyArray<string>;
  busy: boolean;
  onClose: () => void;
  onSave: (device: HardwareDeviceConfig) => Promise<void>;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [draft, setDraft] = useState<HardwareDeviceDraft>(() =>
    original
      ? hardwareDeviceDraftFromConfig(original)
      : { ...EMPTY_HARDWARE_DEVICE_DRAFT, projectId: projects.length === 1 ? projects[0]!.id : "" },
  );
  const [touched, setTouched] = useState<ReadonlySet<HardwareDeviceDraftField>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const parsed = parseHardwareDeviceDraft(draft, takenIds);
  const errorFor = (field: HardwareDeviceDraftField) =>
    !parsed.ok && (submitted || touched.has(field)) ? parsed.errors[field] : undefined;
  const touch = (field: HardwareDeviceDraftField) =>
    setTouched((current) => new Set(current).add(field));
  const set = (patch: Partial<HardwareDeviceDraft>) => setDraft({ ...draft, ...patch });
  const selectedProject = projects.find((project) => project.id === draft.projectId);
  const sourceChanged =
    original?.acceptedDefinition !== undefined &&
    (draft.projectId !== original.projectId ||
      draft.definitionFile.trim() !== original.definitionFile);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup
        showCloseButton={!busy}
        render={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(true);
              if (parsed.ok && !busy) void onSave(parsed.device);
            }}
          />
        }
      >
        <DialogHeader>
          <DialogTitle>{original ? `Edit ${original.id}` : "Add hardware device"}</DialogTitle>
          <DialogDescription>
            The device's actions come from a definition file in the project's repository. This
            environment must be able to reach its address.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <EditorField
              label="Id"
              error={errorFor("id")}
              hint={
                original
                  ? "Fixed once added: its credential and lease history are kept under it."
                  : "Agents use it to name the device."
              }
            >
              <Input
                autoFocus={!original}
                required
                font="mono"
                value={draft.id}
                disabled={busy || original !== null}
                placeholder="tree"
                aria-invalid={errorFor("id") ? true : undefined}
                onBlur={() => touch("id")}
                onChange={(event) => set({ id: event.target.value })}
              />
            </EditorField>
            <EditorField
              label="Project"
              error={errorFor("projectId")}
              hint="Only this project's threads can use the device."
            >
              <Select
                value={draft.projectId || null}
                disabled={busy || projects.length === 0}
                onValueChange={(value) => {
                  touch("projectId");
                  if (typeof value === "string") set({ projectId: value as ProjectId });
                }}
              >
                <SelectTrigger size="sm" aria-label="Project">
                  <SelectValue>
                    {selectedProject?.title ??
                      (projects.length === 0
                        ? "No projects on this environment"
                        : "Choose a project")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </EditorField>
            <EditorField
              label="Definition file"
              error={errorFor("definitionFile")}
              hint={`Read from ${HARDWARE_DEFINITION_DIRECTORY}/ on the project's default branch.`}
            >
              <Input
                required
                font="mono"
                value={draft.definitionFile}
                disabled={busy}
                placeholder="tree.json"
                aria-invalid={errorFor("definitionFile") ? true : undefined}
                onBlur={() => touch("definitionFile")}
                onChange={(event) => set({ definitionFile: event.target.value })}
              />
            </EditorField>
            {sourceChanged ? (
              <p className="text-xs text-muted-foreground">
                You will need to review and accept the new definition.
              </p>
            ) : null}
            <EditorField label="Address" error={errorFor("baseUrl")}>
              <Input
                required
                font="mono"
                value={draft.baseUrl}
                disabled={busy}
                placeholder="http://tree.local"
                aria-invalid={errorFor("baseUrl") ? true : undefined}
                onBlur={() => touch("baseUrl")}
                onChange={(event) => set({ baseUrl: event.target.value })}
              />
            </EditorField>
            <details open={original?.auth !== undefined || undefined} className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">Credential header</summary>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <EditorField label="Header" error={errorFor("auth")}>
                  <Input
                    value={draft.authHeader}
                    disabled={busy}
                    placeholder="Authorization"
                    onBlur={() => touch("auth")}
                    onChange={(event) => set({ authHeader: event.target.value })}
                  />
                </EditorField>
                <EditorField label="Scheme">
                  <Input
                    value={draft.authScheme}
                    disabled={busy}
                    placeholder="Bearer"
                    onBlur={() => touch("auth")}
                    onChange={(event) => set({ authScheme: event.target.value })}
                  />
                </EditorField>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Optional. Set the credential itself from the device's details after saving.
              </p>
            </details>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || (submitted && !parsed.ok)}>
            {busy ? "Saving…" : original ? "Save" : "Add device"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function EditorField({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5 text-sm">
      <span>{label}</span>
      {children}
      {error ? (
        <span role="alert" className="block text-xs text-destructive">
          {error}
        </span>
      ) : hint ? (
        <span className="block text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}
