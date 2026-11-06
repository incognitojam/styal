import { useAtomValue } from "@effect/atom-react";
import {
  LINK_DEFAULT_ACCESS,
  linkAccessLabel,
  linkRequestFailureMessage,
} from "@t3tools/client-runtime/link-request";
import { AuthAccessWriteScope, type EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { PlusIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { peerLinkEnvironment, useLinkableMachines } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import {
  useEnvironmentScope,
  useEnvironmentsWithScope,
  usePreparedConnection,
} from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { ANOTHER_ADDRESS, LinkMachineSelect } from "./LinkMachineSelect";
import { SettingsRow } from "./settingsLayout";
import { useNowMinute } from "../../hooks/useNowMinute";

const failureToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

type PeerLinkHealth = ReturnType<typeof peerLinkHealth>;

export const peerLinkHealthText = (health: PeerLinkHealth) =>
  health.kind === "expired"
    ? "Expired. Add it again with a new pairing code."
    : health.kind === "unreachable"
      ? (health.detail ?? "Not answering right now.")
      : health.kind === "failing"
        ? health.detail
        : health.expiresInDays !== null
          ? `Expires in ${health.expiresInDays} ${health.expiresInDays === 1 ? "day" : "days"}. Add it again to renew.`
          : "Reachable";

const ADD_FIRST_DESCRIPTION =
  "Add one under Environments so your machines can work on each other and share simulators.";

/**
 * Machines the selected one works with that this app isn't connected to, so they can't have a
 * tab of their own. With none of those and no other tabs, it asks for another machine.
 */
export function OtherMachineLinks({
  environmentId,
  environmentLabel,
  knownIds,
  hasOtherTabs,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly knownIds: ReadonlySet<EnvironmentId>;
  readonly hasOtherTabs: boolean;
}) {
  const links = useEnvironmentQuery(peerLinkEnvironment.list({ environmentId, input: {} }));
  if (links.error) {
    return (
      <SettingsRow
        title={`Could not load ${environmentLabel}'s other machines`}
        description={links.error}
      />
    );
  }
  if (!links.data) return null;
  const others = links.data.links.filter((link) => !knownIds.has(link.environmentId));
  if (others.length === 0) {
    return hasOtherTabs ? null : <AddAnotherMachineRow />;
  }
  return (
    <>
      <SettingsRow
        title={`Other machines ${environmentLabel} works with`}
        description="This app isn't connected to these. Add one under Environments to give it a tab here."
      />
      {others.map((link) => (
        <LinkedEnvironmentRow key={link.environmentId} environmentId={environmentId} link={link} />
      ))}
    </>
  );
}

export function AddAnotherMachineRow() {
  return <SettingsRow title="Add another machine first" description={ADD_FIRST_DESCRIPTION} />;
}

function LinkedEnvironmentRow({
  environmentId,
  link,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: PeerLinkSummary;
}) {
  const nowMinute = useNowMinute();
  const health = peerLinkHealth(link, DateTime.makeUnsafe(nowMinute));
  const unlink = useAtomCommand(peerLinkEnvironment.unlink, { label: "unlink environment" });
  const canUnlink = useAtomValue(peerLinkEnvironment.unlink.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const forget = async () => {
    const confirmed = await (requestConfirmDialog(
      `Forget ${link.label}? Agents here stop working there. Revoke "styal · …" in ${link.label}'s Connections to end the session there too.`,
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    const result = await unlink({ environmentId, input: { environmentId: link.environmentId } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast("Could not forget the machine", String(squashAtomCommandFailure(result)));
    }
  };
  const status = peerLinkHealthText(health);
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={status}
              dotClassName={
                health.kind === "reachable"
                  ? health.expiresInDays === null
                    ? "bg-success"
                    : "bg-warning"
                  : health.kind === "expired" || health.kind === "failing"
                    ? "bg-destructive"
                    : "bg-muted-foreground/30"
              }
              pingClassName={null}
            />
            <h3 className="text-sm font-medium text-foreground">{link.label}</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            {link.access === LINK_DEFAULT_ACCESS
              ? status
              : `${status} · ${linkAccessLabel(link.access)}`}
          </p>
          <p className="truncate text-xs text-muted-foreground/80">{link.urls.join(", ")}</p>
        </div>
        {canUnlink ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => void forget()}
            >
              {busy ? "Forgetting…" : "Forget"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Adding starts from one machine, so with several the button asks which. */
export function AddMachineAction({
  hosts,
}: {
  readonly hosts: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>;
}) {
  const writable = useEnvironmentsWithScope(hosts, AuthAccessWriteScope);
  const choices = hosts.filter((host) => writable.has(host.environmentId));
  const [target, setTarget] = useState<EnvironmentId | null>(null);
  const [only] = choices;
  if (only === undefined) return null;
  return (
    <>
      {choices.length === 1 ? (
        <Button size="xs" variant="outline" onClick={() => setTarget(only.environmentId)}>
          <PlusIcon className="size-3" />
          Add machine
        </Button>
      ) : (
        <Menu>
          <MenuTrigger
            render={
              <Button size="xs" variant="outline">
                <PlusIcon className="size-3" />
                Add machine
              </Button>
            }
          />
          <MenuPopup align="end">
            <MenuGroup>
              <MenuGroupLabel>Add a machine for agents on</MenuGroupLabel>
              {choices.map((host) => (
                <MenuItem key={host.environmentId} onClick={() => setTarget(host.environmentId)}>
                  {host.label}
                </MenuItem>
              ))}
            </MenuGroup>
          </MenuPopup>
        </Menu>
      )}
      {target === null ? null : (
        <LinkEnvironmentDialog environmentId={target} onClose={() => setTarget(null)} />
      )}
    </>
  );
}

function LinkEnvironmentDialog({
  environmentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const machines = useLinkableMachines(environmentId, true);
  // Null until the user picks; with no other machines known, only an address is left.
  const [choice, setChoice] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [busy, setBusy] = useState(false);
  // Machines whose minting already failed, so the dialog asks for a code instead.
  const [mintFailed, setMintFailed] = useState<ReadonlySet<EnvironmentId>>(new Set());
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const formId = useId();
  const link = useAtomCommand(peerLinkEnvironment.link, { label: "link environment" });
  const selected = choice ?? (machines.length === 0 ? ANOTHER_ADDRESS : null);
  const machine = machines.find((candidate) => candidate.environmentId === selected) ?? null;
  // This client can mint a code there when it is connected to that
  // environment with a session that may create pairing links.
  const targetId = machine?.environmentId ?? null;
  const connected = usePreparedConnection(targetId);
  const mayMint = useEnvironmentScope(targetId, AuthAccessWriteScope);
  const canMint =
    targetId !== null && Option.isSome(connected) && mayMint && !mintFailed.has(targetId);
  const needsAddress = selected === ANOTHER_ADDRESS || machine?.urls.length === 0;
  const ready =
    selected !== null &&
    (!needsAddress || address.trim().length > 0) &&
    (canMint || pairingCode.trim().length > 0);
  // Settles to the code to link with, or null after reporting why there is none.
  const resolvePairingCode = async () => {
    if (!canMint || targetId === null) return pairingCode.trim();
    const minted = await mintPairingCodeOn(targetId, LINK_DEFAULT_ACCESS);
    if (Result.isSuccess(minted)) return minted.success;
    setMintFailed((failed) => new Set(failed).add(targetId));
    failureToast("Could not add the machine", linkRequestFailureMessage(minted.failure));
    return null;
  };
  const submit = async () => {
    const [url, ...alternateUrls] =
      machine === null || needsAddress ? [address.trim()] : machine.urls;
    if (inFlight.current || !ready || url === undefined) return;
    inFlight.current = true;
    setBusy(true);
    const code = await resolvePairingCode();
    const result =
      code === null
        ? null
        : await link({
            environmentId,
            input: {
              url,
              ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
              ...(machine === null
                ? {}
                : { expectedEnvironmentId: machine.environmentId, expectedLabel: machine.label }),
              pairingCode: code,
              access: LINK_DEFAULT_ACCESS,
            },
          });
    inFlight.current = false;
    setBusy(false);
    if (result === null) return;
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: `Added ${result.value.label}` });
      onClose();
    } else if (!isAtomCommandInterrupted(result)) {
      failureToast("Could not add the machine", String(squashAtomCommandFailure(result)));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a machine</DialogTitle>
          <DialogDescription>
            Agents here can then start, message and wait on threads there. It appears in that
            machine's Connections, where it can be revoked.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-4"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {machines.length > 0 ? (
              <LinkMachineSelect
                machines={machines}
                value={selected}
                disabled={busy}
                onChange={setChoice}
              />
            ) : null}
            {machine?.linked ? (
              <p className="text-xs text-muted-foreground">
                Already added. Adding it again renews it.
              </p>
            ) : null}
            {needsAddress ? (
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">Address</span>
                <Input
                  value={address}
                  onChange={(event) => {
                    setAddress(event.target.value);
                    // Machines found after typing began must not hide the address being typed.
                    if (choice === null) setChoice(ANOTHER_ADDRESS);
                  }}
                  placeholder="https://box.example.ts.net"
                  disabled={busy}
                  autoFocus={machines.length === 0}
                  nativeInput
                  spellCheck={false}
                />
                {machine !== null ? (
                  <span className="block text-xs text-muted-foreground">
                    This app has no address for {machine.label} that another machine can reach.
                    Enter its https or Tailscale address.
                  </span>
                ) : null}
              </label>
            ) : null}
            {selected === null || canMint ? null : (
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">Pairing code</span>
                <Input
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value)}
                  placeholder={
                    machine === null
                      ? "From that machine's Connections, or t3 pair there"
                      : "Paste the code"
                  }
                  disabled={busy}
                  autoComplete="one-time-code"
                  nativeInput
                  spellCheck={false}
                />
                {machine !== null ? (
                  <span className="block text-xs text-muted-foreground">
                    Create a link on {machine.label}: Settings → Connections → Create link, then
                    paste its code here.
                  </span>
                ) : null}
              </label>
            )}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            Cancel
          </DialogClose>
          <Button form={formId} type="submit" disabled={busy || !ready}>
            {busy ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
