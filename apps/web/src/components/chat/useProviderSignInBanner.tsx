import { useAtomValue } from "@effect/atom-react";
import {
  isProviderAuthFailureCode,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import { reportForkClientUsage } from "../../forkClientUsage";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { ProviderAuthenticationSection } from "../settings/ProviderAuthenticationSection";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/** Offers the provider's sign-in where a thread failed because that provider is signed out. */
export function useProviderSignInBanner(input: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly failed: boolean;
  readonly lastErrorCode: string | null | undefined;
  readonly provider: ServerProvider | undefined;
}) {
  const [open, setOpen] = useState(false);
  const start = useAtomCommand(serverEnvironment.startProviderAuth, {
    reportFailure: false,
    reportDefect: false,
  });
  const canSignIn = useAtomValue(
    serverEnvironment.startProviderAuth.permissionAtom(input.environmentId),
  );
  const { provider } = input;
  if (
    !input.failed ||
    !isProviderAuthFailureCode(input.lastErrorCode) ||
    !provider ||
    !(provider.setup?.canAuthenticate || (provider.driver === "acpRegistry" && provider.installed))
  )
    return { item: null, dialog: null };
  const name = provider.displayName?.trim() || provider.driver;
  // A CLI login has one way in and stops nothing, so opening the dialog can start it right away.
  function openSignIn() {
    setOpen(true);
    if (provider?.auth.canLogout !== false || !provider.setup?.canAuthenticate) return;
    reportForkClientUsage(input.environmentId, {
      feature: "provider-sign-in",
      action: "start",
      entryPoint: "thread",
    });
    void start({ environmentId: input.environmentId, input: { instanceId: provider.instanceId } });
  }
  const item: ComposerBannerStackItem = {
    id: `provider-sign-in:${provider.instanceId}`,
    variant: "warning",
    icon: <KeyRoundIcon />,
    title: `${name} needs you to sign in`,
    description: "Sign in, then send your message again.",
    ...(canSignIn
      ? {
          actions: (
            <Button size="xs" variant="outline" onClick={openSignIn}>
              Sign in
            </Button>
          ),
        }
      : {}),
  };
  const dialog = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ProviderInstanceIcon
              driverKind={provider.driver}
              displayName={name}
              accentColor={provider.accentColor}
              showBadge={false}
            />
            <DialogTitle>Sign in to {name}</DialogTitle>
          </div>
        </DialogHeader>
        <ProviderAuthenticationSection
          environmentId={input.environmentId}
          environmentLabel={input.environmentLabel}
          instanceId={provider.instanceId}
          provider={provider}
          readOnly={false}
          usageEntryPoint="thread"
          layout="dialog"
          onDone={() => setOpen(false)}
        />
      </DialogPopup>
    </Dialog>
  );
  return { item, dialog };
}
