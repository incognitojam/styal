import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

export function withGrokProjectInstructions(
  instructions: string | undefined,
  spawn: AcpSessionRuntime.AcpSpawnInput,
): AcpSessionRuntime.AcpSpawnInput {
  return instructions?.trim()
    ? { ...spawn, args: ["--rules", instructions.trim(), ...spawn.args] }
    : spawn;
}
