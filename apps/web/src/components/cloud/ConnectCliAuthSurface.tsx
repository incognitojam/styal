import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

export function ConnectCliAuthorizeSurface() {
  return (
    <StandalonePage>
      <StandalonePageHeader
        context="Terminal sign-in"
        title="Update your styal CLI"
        description="Update styal, then run `styal link login` in your terminal to sign in with an emailed code."
      />
    </StandalonePage>
  );
}
