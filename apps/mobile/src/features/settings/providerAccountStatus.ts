import type { ServerProvider } from "@t3tools/contracts";

/**
 * Whether the server can run a sign-in flow for this provider. Providers that
 * reuse their own CLI's login (Claude, default Codex, OpenCode) only report
 * status, so the accounts screen must not query or offer an in-app flow.
 */
export function supportsInAppSignIn(provider: ServerProvider): boolean {
  return (
    provider.setup?.canAuthenticate === true ||
    (provider.driver === "acpRegistry" && provider.installed)
  );
}

/**
 * The reason a provider cannot be used right now, or null when it is
 * available. Shown instead of a sign-in control that could never succeed.
 */
export function providerUnavailableReason(provider: ServerProvider): string | null {
  if (!provider.enabled) return "Turned off in Settings.";
  if (!provider.installed) return "Not installed on this environment.";
  return null;
}

/** Usable providers first, then turned-off ones, each keeping server order. */
export function sortProvidersForAccounts(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  return [
    ...providers.filter((provider) => provider.enabled),
    ...providers.filter((provider) => !provider.enabled),
  ];
}

/** Status line for a provider whose login belongs to its own CLI. */
export function externalSignInStatus(provider: ServerProvider): string {
  const unavailable = providerUnavailableReason(provider);
  if (unavailable) return unavailable;
  const name = provider.displayName ?? provider.driver;
  const plan = provider.auth.label ? ` (${provider.auth.label})` : "";
  switch (provider.auth.status) {
    case "authenticated":
      return `Signed in with the ${name} CLI${plan}.`;
    case "unauthenticated":
      return `Not signed in. Sign in with the ${name} CLI on this environment.`;
    case "unknown":
      return `Uses the ${name} CLI's sign-in.`;
  }
}
