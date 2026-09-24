import { Atom } from "effect/unstable/reactivity";

/**
 * True from launch until the first Clerk load has activated a relay session, found
 * none, or failed to activate one, so connection errors can tell "still loading"
 * apart from "signed out".
 */
export const cloudAuthCheckingAtom = Atom.make(true).pipe(
  Atom.keepAlive,
  Atom.withLabel("cloud-auth:checking"),
);
