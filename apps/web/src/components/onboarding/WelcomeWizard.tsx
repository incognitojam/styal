import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ScopedProjectRef,
  ServerConfig,
  ServerProvider,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
  CloudIcon,
  CopyIcon,
  LinkIcon,
  MonitorIcon,
  TerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useTerminalCloseConfirmation } from "../../hooks/useTerminalCloseConfirmation";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { useCompleteOnboarding } from "../../onboarding/firstRun";
import {
  getOnboardingProviderState,
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
  selectOnboardingProvidersByDriver,
} from "../../onboarding/providerReadiness.logic";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { randomUUID } from "../../lib/utils";
import { legacyImportPendingCount } from "../../state/dataImport";
import { OnboardingImportStep } from "./OnboardingImportStep";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { isOnboardingRelayEnvironment } from "../../onboarding/targetEnvironment.logic";
import { serverEnvironment } from "../../state/server";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectPairing } from "../../connection/onboarding";
import { getProviderSummary } from "../settings/providerStatus";
import { getDriverOption } from "../settings/providerDriverMeta";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { WizardPanel, WizardSteps } from "../ui/wizard";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { cn } from "../../lib/utils";

/**
 * First-run welcome wizard. Rendered over the workspace at `/welcome` on a
 * fresh install (no completed-onboarding flag, empty workspace). Flow per the
 * onboarding overhaul spec: connection choice → sign-in/pair (remote paths) →
 * agent setup with inline install terminal → projects → optional preferences → main screen.
 * Every step past the connection gate is skippable; the whole wizard is
 * re-runnable by clearing the flag.
 */

type WizardStep = "connection" | "agents" | "projects" | "preferences";

const AGENT_ONBOARDING_THREAD_ID = ThreadId.make("onboarding-agent-setup");
const ONBOARDING_STAGES = ["Connect", "Agents", "Projects"] as const;

export function WelcomeWizard({
  localAvailable,
  onDone,
}: {
  /** Whether this client is authenticated to the server serving the app. */
  readonly localAvailable: boolean;
  readonly onDone: (projectRef?: ScopedProjectRef) => void;
}) {
  const completeOnboarding = useCompleteOnboarding();
  const [step, setStep] = useState<WizardStep>("connection");
  const { environments } = useEnvironments();
  const [selection, setSelection] = useState<ReadonlySet<EnvironmentId> | null>(null);
  const [hasPreferences, setHasPreferences] = useState(false);
  const [setupIds, setSetupIds] = useState<readonly EnvironmentId[]>([]);
  const [isBatchImporting, setIsImporting] = useState(false);
  const pendingLegacyImports = useAtomValue(legacyImportPendingCount);
  const isImporting = isBatchImporting || pendingLegacyImports > 0;
  const [terminalSessions, setTerminalSessions] = useState<
    ReadonlyMap<EnvironmentId, AgentTerminalSession>
  >(new Map());
  const confirmTerminalClose = useTerminalCloseConfirmation();
  const changingStepRef = useRef(false);
  const confirmSessionClose = (session: AgentTerminalSession) =>
    confirmTerminalClose({
      environmentId: session.environmentId,
      threadId: AGENT_ONBOARDING_THREAD_ID,
      targets: [{ terminalId: session.terminalId, label: `Install ${session.driver}` }],
    });
  const changeStep = async (nextStep: WizardStep) => {
    if (changingStepRef.current) return;
    changingStepRef.current = true;
    try {
      for (const session of terminalSessions.values()) {
        if (!(await confirmSessionClose(session))) return;
      }
      setTerminalSessions(new Map());
      setStep(nextStep);
    } finally {
      changingStepRef.current = false;
    }
  };
  const changeTerminalSession = async (
    environmentId: EnvironmentId,
    next: AgentTerminalSession | null,
    exited = false,
  ) => {
    if (changingStepRef.current) return;
    const current = terminalSessions.get(environmentId);
    if (current && !exited && !(await confirmSessionClose(current))) return;
    setTerminalSessions((sessions) => {
      const updated = new Map(sessions);
      if (next) updated.set(environmentId, next);
      else updated.delete(environmentId);
      return updated;
    });
  };
  const finishingPromiseRef = useRef<Promise<boolean> | null>(null);
  const completionErrorToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const primaryEnvironment = usePrimaryEnvironment();
  const selectedIds =
    selection ?? new Set(primaryEnvironment ? [primaryEnvironment.environmentId] : []);
  const startSetup = (ids: readonly EnvironmentId[]) => {
    if (ids.length === 0) return;
    setSetupIds(ids);
    setStep("agents");
  };
  const stageIndex =
    step === "agents" ? 1 : step === "projects" ? 2 : step === "preferences" ? 3 : 0;
  const importStep = step === "projects" || step === "preferences";
  const stages =
    hasPreferences || step === "preferences"
      ? [...ONBOARDING_STAGES, "Preferences"]
      : ONBOARDING_STAGES;
  const finish = useCallback(
    (projectRef?: ScopedProjectRef) => {
      if (finishingPromiseRef.current !== null) return finishingPromiseRef.current;
      if (completionErrorToastIdRef.current !== null) {
        toastManager.close(completionErrorToastIdRef.current);
        completionErrorToastIdRef.current = null;
      }

      const completion = completeOnboarding()
        .then(() => {
          if (completionErrorToastIdRef.current !== null) {
            toastManager.close(completionErrorToastIdRef.current);
            completionErrorToastIdRef.current = null;
          }
          onDone(projectRef);
          return true;
        })
        .catch(() => {
          const errorToast = {
            type: "error",
            title: "Could not finish setup",
            description: "Your settings could not be saved. Try again.",
          } as const;
          if (completionErrorToastIdRef.current === null) {
            completionErrorToastIdRef.current = toastManager.add(errorToast);
          } else {
            toastManager.update(completionErrorToastIdRef.current, errorToast);
          }
          return false;
        })
        .finally(() => {
          if (finishingPromiseRef.current === completion) {
            finishingPromiseRef.current = null;
          }
        });
      finishingPromiseRef.current = completion;
      return completion;
    },
    [completeOnboarding, onDone],
  );

  return (
    <Dialog open disablePointerDismissal onOpenChange={(_, event) => event.cancel()}>
      <DialogPopup
        className={cn(
          "max-w-xl overflow-x-hidden overflow-y-auto",
          importStep && "flex max-h-[calc(100dvh-2rem)] flex-col overflow-y-hidden",
        )}
        bottomStickOnMobile={false}
        showCloseButton={false}
        initialFocus={() => document.getElementById("onboarding-pairing-url") ?? true}
      >
        <DialogTitle className="sr-only">Set up styal</DialogTitle>
        <div className="flex min-h-0 flex-col">
          <DialogHeader className="shrink-0 gap-4">
            <div className="flex items-baseline gap-1.5" role="img" aria-label="styal">
              <span className="text-[1.4rem] font-medium tracking-tight text-muted-foreground">
                styal
              </span>
            </div>
            <WizardSteps
              steps={stages}
              currentStep={stageIndex}
              isStepDisabled={(index) => isImporting || index >= stageIndex}
              onStepChange={(index) => {
                if (isImporting || index > stageIndex) return;
                void changeStep(index === 0 ? "connection" : index === 1 ? "agents" : "projects");
              }}
            />
          </DialogHeader>

          <WizardPanel
            animateHeight={setupIds.length === 0}
            className={cn("min-w-0", importStep && "flex min-h-0 flex-col")}
          >
            {step === "connection" ? (
              <ConnectionStep
                expandPairingInitially={!localAvailable && !hasCloudPublicConfig()}
                selectedIds={selectedIds}
                onSelectionChange={setSelection}
                onToggleEnvironment={(environmentId, checked) =>
                  setSelection((current) => {
                    const next = new Set(current ?? selectedIds);
                    if (checked) next.add(environmentId);
                    else next.delete(environmentId);
                    return next;
                  })
                }
                onContinue={() =>
                  startSetup(
                    environments
                      .filter((environment) => selectedIds.has(environment.environmentId))
                      .map((environment) => environment.environmentId),
                  )
                }
                onPaired={(environmentId) => {
                  setSelection(new Set([...selectedIds, environmentId]));
                }}
              />
            ) : step === "agents" ? (
              <AgentsStep
                environmentIds={setupIds}
                terminalSessions={terminalSessions}
                onTerminalSessionChange={changeTerminalSession}
                onContinue={() => void changeStep("projects")}
              />
            ) : null}
            {setupIds.length > 0 ? (
              <div hidden={!importStep} className="min-h-0">
                <OnboardingImportStep
                  key={JSON.stringify(setupIds)}
                  environmentIds={setupIds}
                  stage={step === "preferences" ? "preferences" : "projects"}
                  setIsImporting={setIsImporting}
                  onDone={finish}
                  onContinue={() => void changeStep("preferences")}
                  onBack={() => void changeStep("projects")}
                  onPreferencesAvailable={setHasPreferences}
                />
              </div>
            ) : null}
          </WizardPanel>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

// ── Step 1: connection choice ────────────────────────────────

function ConnectionStep({
  expandPairingInitially,
  selectedIds,
  onSelectionChange,
  onToggleEnvironment,
  onContinue,
  onPaired,
}: {
  readonly expandPairingInitially: boolean;
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId>) => void;
  readonly onToggleEnvironment: (environmentId: EnvironmentId, checked: boolean) => void;
  readonly onContinue: () => void;
  readonly onPaired: (environmentId: EnvironmentId) => void;
}) {
  const { environments } = useEnvironments();
  const cloudEnabled = hasCloudPublicConfig();
  const directEnvironments = environments.filter(
    (environment) => !cloudEnabled || !isOnboardingRelayEnvironment(environment),
  );
  const [pairingOpen, setPairingOpen] = useState(expandPairingInitially);
  const [isPairing, setIsPairing] = useState(false);
  const ready =
    selectedIds.size > 0 &&
    [...selectedIds].every((id) =>
      environments.some(
        (environment) =>
          environment.environmentId === id && environment.connection.phase === "connected",
      ),
    );
  const continueRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (
      ready &&
      (document.activeElement === document.body ||
        document.activeElement?.getAttribute("role") === "dialog")
    ) {
      continueRef.current?.focus();
    }
  }, [ready]);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Connect your computers
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        Choose one or more computers. We’ll set up agents and projects on each.
      </p>
      {directEnvironments.length > 0 ? (
        <fieldset className="mt-5 space-y-2">
          <legend className="sr-only">Computers to set up</legend>
          {directEnvironments.map((environment) => (
            <label
              key={environment.environmentId}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-3"
            >
              <Checkbox
                checked={selectedIds.has(environment.environmentId)}
                onCheckedChange={(checked) => {
                  const next = new Set(selectedIds);
                  if (checked) next.add(environment.environmentId);
                  else next.delete(environment.environmentId);
                  onSelectionChange(next);
                }}
              />
              <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-sm font-medium break-words">
                    {environment.label}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {environment.connection.phase === "connected" ? "Connected" : "Connecting…"}
                  </span>
                </span>
                {environment.displayUrl ? (
                  <span className="mt-0.5 block text-xs break-all text-muted-foreground">
                    {environment.displayUrl}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="mt-4 space-y-2">
        {cloudEnabled ? (
          <ConnectAccountOption
            disabled={isPairing}
            selectedIds={selectedIds}
            onToggleEnvironment={onToggleEnvironment}
          />
        ) : null}
        <Collapsible
          open={pairingOpen}
          onOpenChange={setPairingOpen}
          className="rounded-lg border border-border bg-background"
        >
          <CollapsibleTrigger
            disabled={isPairing}
            render={
              <Button
                variant="ghost"
                className="h-auto min-h-14 w-full justify-start gap-3 px-3 py-3 text-left whitespace-normal sm:h-auto"
              />
            }
          >
            <LinkIcon className="size-4 text-muted-foreground" />
            <span className="flex-1">Add a computer</span>
            <ChevronRightIcon
              className={cn("size-4 text-muted-foreground", pairingOpen && "rotate-90")}
            />
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="px-3 pb-3">
              <PairingForm
                isPairing={isPairing}
                setIsPairing={setIsPairing}
                onPaired={(environmentId) => {
                  setPairingOpen(false);
                  onPaired(environmentId);
                  requestAnimationFrame(() => continueRef.current?.focus());
                }}
              />
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </div>
      <div className="mt-6 flex items-center justify-end gap-3">
        <Button
          ref={continueRef}
          autoFocus={!expandPairingInitially}
          disabled={!ready || isPairing}
          onClick={onContinue}
        >
          Continue
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </>
  );
}

function ConnectAccountOption({
  disabled,
  selectedIds,
  onToggleEnvironment,
}: {
  readonly disabled: boolean;
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  readonly onToggleEnvironment: (environmentId: EnvironmentId, checked: boolean) => void;
}) {
  const { environments } = useEnvironments();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const [expanded, setExpanded] = useState(true);
  const [discoveryReady, setDiscoveryReady] = useState(false);
  const onDiscoveryReady = useCallback(() => setDiscoveryReady(true), []);

  return (
    <Collapsible
      open={expanded && !!isSignedIn && discoveryReady}
      onOpenChange={setExpanded}
      className="rounded-lg border border-border bg-background"
    >
      <CollapsibleTrigger
        disabled={disabled || !isLoaded}
        onClick={(event) => {
          if (!isSignedIn) {
            event.preventDefault();
            setExpanded(true);
            openAuthPrompt();
          }
        }}
        render={
          <Button
            variant="ghost"
            className="h-auto min-h-14 w-full justify-start gap-3 px-3 py-3 text-left whitespace-normal sm:h-auto"
          />
        }
      >
        <CloudIcon className="size-4 text-muted-foreground" />
        <span className="flex-1">styal Link</span>
        <span className="text-xs text-muted-foreground">
          {!isLoaded
            ? "Loading sign-in…"
            : !isSignedIn
              ? "Sign in"
              : !discoveryReady
                ? "Loading computers…"
                : null}
        </span>
        <ChevronRightIcon
          className={cn("size-4 text-muted-foreground", expanded && isSignedIn && "rotate-90")}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel keepMounted>
        <div className="px-3 pb-3">
          <div className="mb-3 space-y-1.5">
            {isSignedIn ? (
              <CloudEnvironmentConnectRows
                primaryEnvironmentId={null}
                savedEnvironments={environments}
                showSavedEnvironments
                onDiscoveryReady={onDiscoveryReady}
                selection={{ selectedIds, onChange: onToggleEnvironment }}
                refreshWhileEmpty
                empty={
                  <p className="py-3 text-sm text-muted-foreground">No computers linked yet.</p>
                }
              />
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            Run this on each computer you want to connect.
          </p>
          <CommandBlock command="npx @styal/cli link" className="mt-3" />
          <p className="mt-3 text-xs text-muted-foreground">
            Keep styal running. Select the computers you want to set up above.
          </p>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

// ── Step 2′: Direct pairing ──────────────────────────────────

/**
 * Register a computer in this browser using a server-minted pairing link.
 */
function PairingForm({
  isPairing,
  setIsPairing,
  onPaired,
}: {
  readonly isPairing: boolean;
  readonly setIsPairing: (value: boolean) => void;
  readonly onPaired: (environmentId: EnvironmentId) => void;
}) {
  const connectPairingEnvironment = useAtomCommand(connectPairing, { reportFailure: false });
  const [pairingUrl, setPairingUrl] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async () => {
    if (isPairing || pairingUrl.trim().length === 0) return;
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
    <>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <label className="block text-sm text-muted-foreground" htmlFor="onboarding-pairing-url">
            Pairing link
          </label>
          <Input
            id="onboarding-pairing-url"
            autoFocus
            aria-invalid={errorMessage.length > 0}
            aria-describedby={errorMessage ? "onboarding-pairing-error" : undefined}
            className="mt-2"
            size="lg"
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
              if (
                event.key === "Enter" &&
                (event.nativeEvent.isComposing || event.keyCode === 229)
              ) {
                event.preventDefault();
              }
            }}
          />
        </div>
        {errorMessage ? (
          <div
            id="onboarding-pairing-error"
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive"
          >
            {errorMessage}
          </div>
        ) : null}
        <Collapsible>
          <div className="flex items-center justify-between gap-3">
            <CollapsibleTrigger
              type="button"
              className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronRightIcon className="size-3.5 group-data-panel-open:rotate-90" />
              Need a pairing link?
            </CollapsibleTrigger>
            <Button type="submit" disabled={isPairing || pairingUrl.trim().length === 0}>
              {isPairing ? "Pairing..." : "Pair"}
            </Button>
          </div>
          <CollapsiblePanel className="pt-3">
            <p className="text-sm text-muted-foreground">
              Run this on the computer with your code.
            </p>
            <CommandBlock command="npx @styal/cli pair" className="mt-2" />
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Start styal first, or run <code className="font-mono">npx @styal/cli serve</code>. Add{" "}
              <code className="font-mono">--tailscale</code> to use your tailnet.
            </p>
          </CollapsiblePanel>
        </Collapsible>
      </form>
    </>
  );
}

// ── Step 3: agents ───────────────────────────────────────────

const PRIMARY_AGENT_DRIVERS = ["claudeAgent", "codex"] as const;
type OnboardingAgentDriver = (typeof PRIMARY_AGENT_DRIVERS)[number];

/** Setup values stay fixed while provider probes refresh the surrounding cards. */
interface AgentTerminalSession {
  readonly terminalId: string;
  readonly environmentId: EnvironmentId;
  readonly driver: OnboardingAgentDriver;
  readonly providerInstanceId: ServerProvider["instanceId"];
  readonly cwd: string;
  readonly command: string;
  readonly keybindings: ServerConfig["keybindings"];
}

/**
 * Claude Code and Codex use live probe status. Install opens the built-in
 * terminal inline with the vendor's standalone installer pre-typed. The update
 * RPC can't install a binary that isn't there yet (it infers the installer from
 * the installed binary's path), and the terminal also handles the interactive
 * login that follows.
 */
function AgentsStep({
  environmentIds,
  terminalSessions,
  onTerminalSessionChange,
  onContinue,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly terminalSessions: ReadonlyMap<EnvironmentId, AgentTerminalSession>;
  readonly onTerminalSessionChange: (
    environmentId: EnvironmentId,
    session: AgentTerminalSession | null,
    exited?: boolean,
  ) => Promise<void>;
  readonly onContinue: () => void;
}) {
  const { environments } = useEnvironments();
  return (
    <StepShell title="Your agents" description="Agents available on your selected computers.">
      <ScrollArea
        scrollFade
        className="mt-5 h-auto max-h-96 [&_[data-slot=scroll-area-scrollbar]]:opacity-100"
      >
        <div className="space-y-5 pr-3">
          {environmentIds.map((environmentId) => (
            <ConnectedAgentsStep
              key={environmentId}
              environmentId={environmentId}
              terminalSession={terminalSessions.get(environmentId) ?? null}
              onTerminalSessionChange={(session, exited) =>
                onTerminalSessionChange(environmentId, session, exited)
              }
              machineLabel={
                environments.find((environment) => environment.environmentId === environmentId)
                  ?.label ?? "Computer"
              }
            />
          ))}
        </div>
      </ScrollArea>
      <div className="mt-6 flex justify-end">
        <Button autoFocus onClick={onContinue}>
          Continue
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </StepShell>
  );
}

function ConnectedAgentsStep({
  environmentId,
  machineLabel,
  terminalSession,
  onTerminalSessionChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly terminalSession: AgentTerminalSession | null;
  readonly onTerminalSessionChange: (
    session: AgentTerminalSession | null,
    exited?: boolean,
  ) => Promise<void>;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));

  // Re-probe on entry so freshly installed CLIs show up without a manual
  // refresh; harmless when nothing changed (single-flighted per environment).
  useEffect(() => {
    void refreshProviders({ environmentId, input: {} });
  }, [environmentId, refreshProviders]);

  const byDriver = useMemo(() => selectOnboardingProvidersByDriver(providers), [providers]);

  const primaryAgents = PRIMARY_AGENT_DRIVERS.map((driver) => ({
    driver,
    provider: byDriver.get(driver),
  }));
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">{machineLabel}</h2>
      <div className="space-y-1.5">
        {primaryAgents.map(({ driver, provider }) => (
          <AgentCard
            key={driver}
            driver={driver}
            provider={provider}
            terminalOpen={terminalSession?.driver === driver}
            terminalAvailable={serverConfig !== null}
            onOpenTerminal={() => {
              if (provider === undefined || serverConfig === null) return;
              void onTerminalSessionChange({
                terminalId: `onboarding-${driver}-${randomUUID()}`,
                environmentId,
                driver,
                providerInstanceId: provider.instanceId,
                cwd: serverConfig.cwd,
                command: provider.installed
                  ? resolveOnboardingProviderLoginCommand(
                      provider,
                      serverConfig.settings,
                      serverConfig.environment.platform.os,
                    )
                  : resolveOnboardingProviderInstallCommand(
                      driver,
                      serverConfig.environment.platform.os,
                    ),
                keybindings: serverConfig.keybindings,
              });
            }}
          />
        ))}
      </div>
      {terminalSession !== null ? (
        <AgentInstallTerminal
          key={`${terminalSession.environmentId}:${terminalSession.providerInstanceId}:${terminalSession.driver}`}
          session={terminalSession}
          onClose={(exited = false) => {
            void onTerminalSessionChange(null, exited).then(() =>
              refreshProviders({ environmentId, input: {} }),
            );
          }}
        />
      ) : null}
    </section>
  );
}

function AgentCard({
  driver,
  provider,
  terminalOpen,
  terminalAvailable,
  onOpenTerminal,
}: {
  readonly driver: OnboardingAgentDriver;
  readonly provider: ServerProvider | undefined;
  readonly terminalOpen: boolean;
  readonly terminalAvailable: boolean;
  readonly onOpenTerminal: () => void;
}) {
  const meta = getDriverOption(ProviderDriverKind.make(driver));
  const Icon = meta?.icon;
  const displayName = driver === "claudeAgent" ? "Claude Code" : (meta?.label ?? driver);
  const summary = getProviderSummary(provider);
  const providerState = getOnboardingProviderState(provider);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
      {Icon ? (
        <Icon className={cn("size-5 shrink-0", driver !== "claudeAgent" && "fill-foreground")} />
      ) : null}
      <div className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{displayName}</span>
        <p className="mt-0.5 text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
          {summary.headline}
          {summary.detail ? ` · ${summary.detail}` : ""}
        </p>
      </div>
      <div className="shrink-0">
        {providerState === "ready" ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
            <CheckIcon className="size-3.5" />
            Ready
          </span>
        ) : providerState === "checking" ? (
          <span className="text-xs text-muted-foreground">Checking...</span>
        ) : providerState === "disabled" ? (
          <span className="text-xs text-muted-foreground">Disabled</span>
        ) : providerState === "attention" ? (
          <span className="text-xs text-muted-foreground">{summary.headline}</span>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            onClick={onOpenTerminal}
            disabled={terminalOpen || !terminalAvailable}
          >
            <TerminalIcon className="size-3.5" />
            {providerState === "signIn" ? "Sign in" : "Install"}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Inline install terminal. Opens a PTY on the connected environment under a
 * synthetic onboarding thread id (terminals are keyed by free-form thread id;
 * the server validates only the cwd) and pre-types the install or login
 * command without submitting, so the user reviews and presses Enter.
 */
function AgentInstallTerminal({
  session,
  onClose,
}: {
  readonly session: AgentTerminalSession;
  readonly onClose: (exited?: boolean) => void;
}) {
  const { command, cwd, driver, environmentId, keybindings, providerInstanceId, terminalId } =
    session;
  // Same terminal typography preference the thread drawer honors.
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const setupQueueRef = useRef(Promise.resolve());
  const setupGenerationRef = useRef(0);
  const activeSetupGenerationRef = useRef<number | null>(null);
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, AGENT_ONBOARDING_THREAD_ID),
    [environmentId],
  );
  const [setupAttempt, setSetupAttempt] = useState(0);
  const [setupState, setSetupState] = useState<
    "preparing" | "ready" | "openFailed" | "writeFailed"
  >("preparing");
  const terminalReady = setupState === "ready" || setupState === "writeFailed";

  // Keep each setup generation distinct. In Strict Mode, a canceled open can
  // finish after the replacement setup starts; it must not close or pre-type
  // into the replacement session that shares this terminal id.
  useEffect(() => {
    const generation = setupGenerationRef.current + 1;
    setupGenerationRef.current = generation;
    activeSetupGenerationRef.current = generation;
    setSetupState("preparing");

    setupQueueRef.current = setupQueueRef.current.then(async () => {
      if (activeSetupGenerationRef.current !== generation) return;
      const opened = await openTerminal({
        environmentId,
        input: {
          threadId: AGENT_ONBOARDING_THREAD_ID,
          terminalId,
          cwd,
          providerInstanceId,
        },
      });
      if (opened._tag !== "Success") {
        if (activeSetupGenerationRef.current === generation) setSetupState("openFailed");
        return;
      }

      if (activeSetupGenerationRef.current !== generation) return;

      const wrote = await writeTerminal({
        environmentId,
        input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, data: command },
      });
      if (activeSetupGenerationRef.current !== generation) return;
      setSetupState(wrote._tag === "Success" ? "ready" : "writeFailed");
    });

    // User-driven exits confirm server-reported activity before unmounting.
    // Cleanup also releases the PTY after a natural session exit.
    return () => {
      if (activeSetupGenerationRef.current === generation) {
        activeSetupGenerationRef.current = null;
      }
      setupQueueRef.current = setupQueueRef.current.then(async () => {
        await closeTerminal({
          environmentId,
          input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, deleteHistory: true },
        });
      });
    };
  }, [
    closeTerminal,
    command,
    cwd,
    environmentId,
    openTerminal,
    providerInstanceId,
    setupAttempt,
    terminalId,
    writeTerminal,
  ]);

  return (
    <div className="thread-terminal-drawer mt-4 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground">
      <div className="flex items-center justify-between border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          {setupState === "writeFailed" ? (
            <>
              Run <code className="rounded bg-muted px-1 font-mono">{command}</code> in this
              terminal.
            </>
          ) : setupState === "ready" ? (
            "Review the command, then press Enter to run it."
          ) : setupState === "openFailed" ? (
            "Could not open the setup terminal."
          ) : (
            "Preparing command..."
          )}
        </span>
        <div className="flex items-center gap-1">
          {setupState === "openFailed" ? (
            <Button size="xs" variant="ghost" onClick={() => setSetupAttempt((value) => value + 1)}>
              Retry
            </Button>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={() => onClose()}>
            Close
          </Button>
        </div>
      </div>
      <div className="h-64">
        {terminalReady ? (
          <TerminalViewport
            threadRef={threadRef}
            threadId={AGENT_ONBOARDING_THREAD_ID}
            terminalId={terminalId}
            terminalLabel={`Install ${driver}`}
            cwd={cwd}
            providerInstanceId={providerInstanceId}
            advancedTypography={advancedTypography}
            onSessionExited={() => onClose(true)}
            focusRequestId={1}
            autoFocus
            resizeEpoch={0}
            drawerHeight={256}
            keybindings={keybindings}
          />
        ) : null}
      </div>
    </div>
  );
}

// ── Step 4: import ───────────────────────────────────────────

// ── Shared bits ──────────────────────────────────────────────

function StepShell({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      {description ? (
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </>
  );
}

function CommandBlock({
  command,
  className,
  prominent = false,
}: {
  readonly command: string;
  readonly className?: string;
  readonly prominent?: boolean;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: "command",
  });
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/50 font-mono",
        prominent ? "px-4 py-3.5 text-base" : "px-3 py-2.5 text-sm",
        className,
      )}
    >
      <span className="min-w-0 truncate">
        <span className="mr-2 text-muted-foreground">$</span>
        {command}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Copy command"
        onClick={() => copyToClipboard(command, undefined)}
      >
        {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}
