import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OrchestrationV2AuthRecovery,
  OrchestrationV2AuthRecoveryUpdate,
  ProviderInstanceId,
  RunId,
  ServerProvider,
} from "@t3tools/contracts";
import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { ProviderAuthenticationSection } from "../settings/ProviderAuthenticationSection";
import { RefreshIcon } from "../ui/refresh-icon";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import type { ProviderBanner } from "./ProviderStatusBanner";

/** Offers the provider's sign-in where it is signed out, before or after a turn failed for it. */
export function useProviderSignInBanner(input: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly banner: ProviderBanner;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly runId: RunId | null | undefined;
  readonly recovery: OrchestrationV2AuthRecovery | null | undefined;
  readonly onChangeWaiting: (update: OrchestrationV2AuthRecoveryUpdate) => Promise<void>;
  readonly onDismiss: () => void;
}) {
  // The dialog outlives the banner, so it can say "Signed in." once the provider reads signed in.
  const [signIn, setSignIn] = useState<SignInDialogTarget | null>(null);
  // A dialog opened for one environment never acts on another environment's provider.
  if (signIn && signIn.environmentId !== input.environmentId) setSignIn(null);
  const close = () => setSignIn((current) => (current ? { ...current, open: false } : null));
  const start = useAtomCommand(serverEnvironment.startProviderAuth, {
    reportFailure: false,
    reportDefect: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    label: "Refresh provider status",
  });
  const [pending, setPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const canSignIn = useAtomValue(
    serverEnvironment.startProviderAuth.permissionAtom(input.environmentId),
  );
  const canRefresh = useAtomValue(
    serverEnvironment.refreshProviders.permissionAtom(input.environmentId),
  );
  const dialogProvider = signInDialogProvider(signIn, input.environmentId, input.providers);
  const dialog =
    signIn && dialogProvider ? (
      <Dialog open={signIn.open} onOpenChange={(open) => (open ? undefined : close())}>
        <DialogPopup>
          <DialogHeader>
            <div className="flex items-center gap-2">
              <ProviderInstanceIcon
                driverKind={dialogProvider.driver}
                displayName={providerName(dialogProvider)}
                accentColor={dialogProvider.accentColor}
                showBadge={false}
              />
              <DialogTitle>Sign in to {providerName(dialogProvider)}</DialogTitle>
            </div>
          </DialogHeader>
          <ProviderAuthenticationSection
            environmentId={input.environmentId}
            environmentLabel={input.environmentLabel}
            instanceId={dialogProvider.instanceId}
            provider={dialogProvider}
            readOnly={false}
            layout="dialog"
            onDone={close}
          />
        </DialogPopup>
      </Dialog>
    ) : null;
  if (input.banner?.kind !== "sign-in") return { item: null, dialog };
  const { provider, afterFailedTurn } = input.banner;
  const name = providerName(provider);
  // A CLI login has one way in and stops nothing, so opening the dialog can start it right away.
  function openSignIn() {
    setSignIn({
      environmentId: input.environmentId,
      instanceId: provider.instanceId,
      open: true,
    });
    if (provider.auth.canLogout !== false || !provider.setup?.canAuthenticate) return;

    void start({ environmentId: input.environmentId, input: { instanceId: provider.instanceId } });
  }
  const recovery = afterFailedTurn && input.recovery?.runId === input.runId ? input.recovery : null;
  const waiting = recovery?.waiting === true;
  async function setWaiting(next: boolean) {
    if (!input.runId) return;
    setPending(true);
    try {
      await input.onChangeWaiting({ runId: input.runId, waiting: next });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not change this thread",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    }
    setPending(false);
  }
  // A login finished in a terminal shows up at the next status check; this checks now.
  async function refresh() {
    setRefreshing(true);
    await refreshProviders({
      environmentId: input.environmentId,
      input: { instanceId: provider.instanceId, refreshModels: true },
    });
    setRefreshing(false);
  }
  const item: ComposerBannerStackItem = {
    id: `provider-sign-in:${provider.instanceId}`,
    variant: "warning",
    icon: <KeyRoundIcon />,
    title: `${name} needs you to sign in`,
    description: !afterFailedTurn
      ? "Sign in to send messages."
      : waiting
        ? "It continues after you sign in."
        : "Sign in, then send your message again.",
    ...(afterFailedTurn
      ? {}
      : { dismissLabel: `Dismiss ${name} sign-in`, onDismiss: input.onDismiss }),
    actions: (
      <>
        {recovery ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={() => void setWaiting(!waiting)}
          >
            {waiting ? "Stop waiting" : "Continue after sign-in"}
          </Button>
        ) : null}
        {!afterFailedTurn && canRefresh ? (
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Refresh ${name} status`}
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <RefreshIcon />
            {refreshing ? "Refreshing..." : "Refresh"}
          </Button>
        ) : null}
        {canSignIn ? (
          <Button size="xs" variant="outline" onClick={openSignIn}>
            Sign in
          </Button>
        ) : null}
      </>
    ),
  };
  return { item, dialog };
}

interface SignInDialogTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly open: boolean;
}

/** The provider an open sign-in dialog acts on, only on the environment it was opened for. */
export function signInDialogProvider(
  target: SignInDialogTarget | null,
  environmentId: EnvironmentId,
  providers: ReadonlyArray<ServerProvider>,
): ServerProvider | undefined {
  if (!target || target.environmentId !== environmentId) return undefined;
  return providers.find((provider) => provider.instanceId === target.instanceId);
}

function providerName(provider: ServerProvider) {
  return provider.displayName?.trim() || provider.driver;
}
