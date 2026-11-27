import { useGT } from "gt-react";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

export function ConnectCliAuthorizeSurface() {
  const gt = useGT();
  return (
    <StandalonePage>
      <StandalonePageHeader
        context={gt("Terminal sign-in")}
        title={gt("Update your styal CLI")}
        description={gt(
          "Update styal, then run `styal link login` in your terminal to sign in with an emailed code.",
        )}
      />
    </StandalonePage>
  );
}
