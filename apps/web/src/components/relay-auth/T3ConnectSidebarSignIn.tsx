import { LogInIcon } from "lucide-react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useRelayAccount } from "../../cloud/useRelayAccount";
import { Button } from "../ui/button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { openRelayAccount, openRelaySignIn } from "./relayAuthDialogs";

export function T3ConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useRelayAccount();
  if (!hasCloudPublicConfig() || !isLoaded || isSignedIn) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={openRelaySignIn}>
          <LogInIcon />
          <span>Sign in to styal Link</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** Opens the account dialog; shows the first letter of the account's email. */
export function T3ConnectSidebarAvatar() {
  const { email, isSignedIn } = useRelayAccount();
  if (!hasCloudPublicConfig() || !isSignedIn) return null;
  const initial = email?.trim().charAt(0).toUpperCase() || "S";

  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={email ? `styal Link account ${email}` : "styal Link account"}
      onClick={openRelayAccount}
    >
      <span className="flex size-6 items-center justify-center rounded-full bg-muted text-xs font-medium">
        {initial}
      </span>
    </Button>
  );
}

/** Compact sign-in action for notices about a styal Link environment that needs a cloud session. */
export function T3ConnectSignInButton() {
  const { isLoaded, isSignedIn } = useRelayAccount();
  if (!hasCloudPublicConfig() || !isLoaded || isSignedIn) return null;

  return (
    <Button size="xs" variant="ghost" onClick={openRelaySignIn}>
      Sign in
    </Button>
  );
}
