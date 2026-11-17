import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createRegenerableFilesAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    review: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "regenerable-files:patterns",
      tag: WS_METHODS.projectsWorktreeCleanupReview,
    }),
  };
}
