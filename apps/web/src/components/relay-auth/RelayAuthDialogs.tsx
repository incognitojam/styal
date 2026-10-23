import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { RelayAccountDialog } from "./RelayAccountDialog";
import { RelaySignInDialog } from "./RelaySignInDialog";

/** One host for the styal Link sign-in and account dialogs, opened from anywhere. */
export function RelayAuthDialogs() {
  if (!hasCloudPublicConfig()) return null;
  return (
    <>
      <RelaySignInDialog />
      <RelayAccountDialog />
    </>
  );
}
