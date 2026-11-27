import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { Atom } from "effect/reactivity";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createProjectActionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "project-actions:list",
      tag: WS_METHODS.projectActions,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    read: createEnvironmentRpcCommand(runtime, {
      label: "project-actions:read",
      tag: WS_METHODS.projectActions,
    }),
    setApproval: createEnvironmentRpcCommand(runtime, {
      label: "project-actions:approval",
      tag: WS_METHODS.projectSetActionApproval,
    }),
    run: createEnvironmentRpcCommand(runtime, {
      label: "project-actions:run",
      tag: WS_METHODS.projectRunAction,
    }),
  };
}
