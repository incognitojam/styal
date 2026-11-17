import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createWorktreeCleanupAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    review: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "worktree-cleanup:patterns",
      tag: WS_METHODS.projectsWorktreeCleanupReview,
    }),
  };
}
