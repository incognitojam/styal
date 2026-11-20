import { useRelayAccount } from "../../cloud/useRelayAccount";
import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { ChevronDownIcon, ChevronRightIcon, CloudIcon, LinkIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { connectPairing } from "../../connection/onboarding";
import { resolveHostedConnectionSetup } from "../../onboarding/firstRun.logic";
import {
  isOnboardingRelayEnvironment,
  resolveOnboardingSetup,
} from "../../onboarding/targetEnvironment.logic";
import { useEnvironmentShellStatuses } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { environmentProjects } from "../../state/projects";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { openRelaySignIn } from "../relay-auth/relayAuthDialogState";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";
import { presentSavedCloudEnvironmentConnection } from "../cloud/cloudEnvironmentConnectionPresentation";
import { InstallT3Commands } from "../InstallT3Commands";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { RowIcon, WelcomeSection } from "./welcomeLayout";

// A sorted id list, so thread and project updates re-render the page only when it changes.
const environmentsWithWorkAtom = Atom.make((get) =>
  [
    ...new Set([
      ...get(environmentProjects.projectsAtom).map((project) => project.environmentId),
      ...get(environmentThreadShells.threadShellsAtom).map((thread) => thread.environmentId),
    ]),
  ]
    .toSorted()
    .join(","),
).pipe(Atom.withLabel("web-welcome-environments-with-work"));

/**
 * The selected computers the page sets up: connected ones, and on the hosted app's automatic first
 * run only those without projects or threads once their workspace is live. `hold` keeps the
 * computers being set up when Start begins, so the projects an import adds cannot drop them.
 */
export function useWelcomeComputers(
  selectedIds: ReadonlySet<EnvironmentId>,
  automaticHostedFirstRun: boolean,
) {
  const { environments } = useEnvironments();
  const connection = resolveOnboardingSetup(environments, selectedIds);
  const shellStatuses = useEnvironmentShellStatuses();
  const [heldIds, setHeldIds] = useState<ReadonlySet<EnvironmentId>>(new Set());
  const withWork = new Set(
    useAtomValue(environmentsWithWorkAtom)
      .split(",")
      .filter((id) => id.length > 0)
      .map((id) => EnvironmentId.make(id))
      .filter((id) => !heldIds.has(id)),
  );
  const connecting = selectedIds.size > 0 && !connection.ready;
  if (!automaticHostedFirstRun) {
    return {
      setupIds: connection.environmentIds,
      skippedIds: connection.skippedIds,
      checkingComputers: connecting && connection.environmentIds.length === 0,
      computersAlreadySetUp: false,
      hold: () => {},
    };
  }
  const hosted = resolveHostedConnectionSetup({
    environmentIds: connection.environmentIds,
    liveEnvironmentIds: new Set(
      [...shellStatuses]
        .filter(([, status]) => status === "live")
        .map(([environmentId]) => environmentId),
    ),
    projectEnvironmentIds: withWork,
    threadEnvironmentIds: withWork,
  });
  const decided = connection.ready && hosted._tag !== "Pending";
  const setupIds = decided && hosted._tag === "Setup" ? hosted.environmentIds : [];
  return {
    setupIds,
    skippedIds: connection.skippedIds,
    checkingComputers:
      selectedIds.size > 0 && !decided && (connecting || hosted._tag === "Pending"),
    computersAlreadySetUp: decided && hosted._tag === "Complete",
    hold: () => setHeldIds((current) => new Set([...current, ...setupIds])),
  };
}

/**
 * Which computers the page sets up. Saved computers are listed with their connection; styal Link
 * lists computers linked to the account, which connect only once they are selected.
 */
export function WelcomeComputersSection({
  selectedIds,
  skippedLabels,
  pairingFirst,
  disabled,
  onToggle,
  onPaired,
}: {
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  // Setup is running, so the computers it works on stay as they are.
  readonly disabled: boolean;
  // Selected computers that are not connected, which the bands below leave out.
  readonly skippedLabels: ReadonlyArray<string>;
  // Without this computer or styal Link, pairing is the only way to add one.
  readonly pairingFirst: boolean;
  readonly onToggle: (environmentId: EnvironmentId, selected: boolean) => void;
  readonly onPaired: (environmentId: EnvironmentId) => void;
}) {
  const { environments } = useEnvironments();
  const cloudEnabled = hasCloudPublicConfig();
  // With styal Link, linked computers are listed under it with their discovery state.
  const directEnvironments = environments.filter(
    (environment) => !cloudEnabled || !isOnboardingRelayEnvironment(environment),
  );
  const [pairingOpen, setPairingOpen] = useState(pairingFirst);
  const [isPairing, setIsPairing] = useState(false);
  return (
    <WelcomeSection title="Computers">
      {directEnvironments.map((environment) => {
        const unsupported = environment.connection.phase === "unsupported";
        return (
          <label
            key={environment.environmentId}
            className="flex min-h-10 cursor-pointer items-center gap-3 py-1 has-disabled:cursor-default"
          >
            <RowIcon>
              <Checkbox
                checked={!unsupported && selectedIds.has(environment.environmentId)}
                disabled={unsupported || isPairing || disabled}
                onCheckedChange={(checked) => onToggle(environment.environmentId, checked)}
              />
            </RowIcon>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium break-words text-foreground">
                {environment.label}
              </span>
              {unsupported && environment.connection.error ? (
                <span className="block text-xs text-muted-foreground">
                  {environment.connection.error}
                </span>
              ) : environment.displayUrl ? (
                <span className="block text-xs break-all text-muted-foreground">
                  {environment.displayUrl}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {!environment.entry.enabled && !unsupported
                ? "Hidden"
                : presentSavedCloudEnvironmentConnection(environment.connection).buttonLabel}
            </span>
          </label>
        );
      })}
      {cloudEnabled ? (
        <LinkedComputers
          disabled={isPairing || disabled}
          selectedIds={selectedIds}
          onToggle={onToggle}
        />
      ) : null}
      <Collapsible open={pairingOpen} onOpenChange={setPairingOpen}>
        <CollapsibleTrigger
          disabled={isPairing || disabled}
          className="group flex min-h-10 w-full items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <RowIcon>
            <LinkIcon className="size-4" />
          </RowIcon>
          <span className="text-sm text-muted-foreground group-hover:text-foreground">
            Add a computer with a pairing link
          </span>
          <ChevronDownIcon className="ml-auto size-4 text-muted-foreground group-data-panel-open:rotate-180" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="pb-2 pl-8">
            <PairingForm
              disabled={disabled}
              isPairing={isPairing}
              setIsPairing={setIsPairing}
              onPaired={(environmentId) => {
                setPairingOpen(false);
                onPaired(environmentId);
              }}
            />
          </div>
        </CollapsiblePanel>
      </Collapsible>
      {skippedLabels.length > 0 ? (
        <p className="pl-8 text-xs text-muted-foreground">
          Not connected, so setup skips {skippedLabels.join(", ")}. You can set{" "}
          {skippedLabels.length === 1 ? "it" : "them"} up later from Settings.
        </p>
      ) : null}
    </WelcomeSection>
  );
}

function LinkedComputers({
  disabled,
  selectedIds,
  onToggle,
}: {
  readonly disabled: boolean;
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  readonly onToggle: (environmentId: EnvironmentId, selected: boolean) => void;
}) {
  const { environments } = useEnvironments();
  const { isLoaded, isSignedIn } = useRelayAccount();
  const [discoveryReady, setDiscoveryReady] = useState(false);
  const onDiscoveryReady = () => setDiscoveryReady(true);
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <div>
      <div className="flex min-h-10 items-center gap-3 py-1">
        <RowIcon>
          <CloudIcon className="size-4" />
        </RowIcon>
        <span className="min-w-0 flex-1 text-sm text-foreground">
          Computers linked to your styal Link account
        </span>
        {!isLoaded ? (
          <span className="text-xs text-muted-foreground">Loading sign-in…</span>
        ) : !isSignedIn ? (
          <Button size="xs" variant="outline" disabled={disabled} onClick={openRelaySignIn}>
            Sign in
          </Button>
        ) : !discoveryReady ? (
          <span className="text-xs text-muted-foreground">Loading computers…</span>
        ) : null}
      </div>
      {isSignedIn ? (
        <CloudEnvironmentConnectRows
          primaryEnvironmentId={null}
          savedEnvironments={environments}
          showSavedEnvironments
          onDiscoveryReady={onDiscoveryReady}
          selection={{ selectedIds, onChange: onToggle, disabled }}
          plainRows
          refreshWhileEmpty
          empty={<p className="pl-8 text-xs text-muted-foreground">No computers linked yet.</p>}
        />
      ) : null}
      <Collapsible open={helpOpen} onOpenChange={setHelpOpen}>
        <CollapsibleTrigger className="group ml-8 flex items-center gap-1 py-1 text-xs text-muted-foreground hover:text-foreground">
          <ChevronRightIcon className="size-3.5 group-data-panel-open:rotate-90" />
          Link another computer
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="pb-2 pl-8">
            <p className="pt-1 text-xs text-muted-foreground">
              Run this on each computer you want to link, and keep styal running there.
            </p>
            <InstallT3Commands command="styal link" className="mt-2" />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function PairingForm({
  disabled,
  isPairing,
  setIsPairing,
  onPaired,
}: {
  readonly disabled: boolean;
  readonly isPairing: boolean;
  readonly setIsPairing: (value: boolean) => void;
  readonly onPaired: (environmentId: EnvironmentId) => void;
}) {
  const connectPairingEnvironment = useAtomCommand(connectPairing, { reportFailure: false });
  const [pairingUrl, setPairingUrl] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const mountedRef = useRef(true);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks mount so a pairing request that settles after unmount does not set state
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async () => {
    if (disabled || isPairing || pairingUrl.trim().length === 0) return;
    setIsPairing(true);
    setErrorMessage("");
    const result = await connectPairingEnvironment({ pairingUrl: pairingUrl.trim() });
    if (!mountedRef.current) return;
    setIsPairing(false);
    if (result._tag === "Success") {
      onPaired(result.value);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    setErrorMessage(cause instanceof Error ? cause.message : "Pairing failed.");
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-2">
        <Input
          id="onboarding-pairing-url"
          aria-label="Pairing link"
          aria-invalid={errorMessage.length > 0}
          aria-describedby={errorMessage ? "onboarding-pairing-error" : undefined}
          className="min-w-0 flex-1"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          nativeInput
          readOnly={isPairing}
          placeholder="https://your-server:5230/pair#token=…"
          value={pairingUrl}
          onChange={(event) => setPairingUrl(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
              event.preventDefault();
            }
          }}
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={disabled || isPairing || pairingUrl.trim().length === 0}
        >
          {isPairing ? "Pairing…" : "Pair"}
        </Button>
      </div>
      {errorMessage ? (
        <Alert id="onboarding-pairing-error" variant="error">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}
      <Collapsible>
        <CollapsibleTrigger
          type="button"
          className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronRightIcon className="size-3.5 group-data-panel-open:rotate-90" />
          Need a pairing link?
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <p className="pt-2 text-xs text-muted-foreground">On the computer with your code:</p>
          <InstallT3Commands command="styal pair" className="mt-2" />
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Start styal or run <code className="font-mono">styal serve</code> there before{" "}
            <code className="font-mono">styal pair</code>. On a tailnet, run{" "}
            <code className="font-mono">styal pair --tailscale</code> instead.
          </p>
        </CollapsiblePanel>
      </Collapsible>
    </form>
  );
}
