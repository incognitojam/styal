import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";

export const relaySignInDialogOpenAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("relay-auth:sign-in-dialog-open"),
);

export const relayAccountDialogOpenAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("relay-auth:account-dialog-open"),
);

export function openRelaySignIn(): void {
  appAtomRegistry.set(relaySignInDialogOpenAtom, true);
}

export function openRelayAccount(): void {
  appAtomRegistry.set(relayAccountDialogOpenAtom, true);
}

/** Opens the styal Link sign-in dialog. Kept as a hook so entry points read the same everywhere. */
export function useT3ConnectAuthPrompt() {
  return { authPrompt: null, openAuthPrompt: openRelaySignIn };
}
