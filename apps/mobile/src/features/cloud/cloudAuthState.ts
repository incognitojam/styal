import { Atom } from "effect/unstable/reactivity";

/**
 * True from launch until the first Clerk load has either activated a relay session
 * or confirmed there is none, so connection errors can tell "still loading" apart
 * from "signed out".
 */
export const cloudAuthCheckingAtom = Atom.make(true).pipe(
  Atom.keepAlive,
  Atom.withLabel("cloud-auth:checking"),
);
