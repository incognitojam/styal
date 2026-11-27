import { useRelayAccount } from "../../cloud/useRelayAccount";
import { openRelayAccount } from "../relay-auth/relayAuthDialogState";
export type T3ConnectAccountPageUrl = "mobile-clients" | "t3-connect" | "t3-chat";
export function useT3ConnectAccountPage() {
  const { isSignedIn } = useRelayAccount();
  return {
    open: isSignedIn ? (_page?: T3ConnectAccountPageUrl) => openRelayAccount() : null,
    portals: null,
  };
}
