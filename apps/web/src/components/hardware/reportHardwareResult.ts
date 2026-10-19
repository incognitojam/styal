import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { toastManager } from "../ui/toast";

/** Toast a failed hardware command; returns whether it succeeded. */
export function reportHardwareResult(
  result: AtomCommandResult<unknown, unknown>,
  title: string,
): boolean {
  if (result._tag === "Success") return true;
  if (isAtomCommandInterrupted(result)) return false;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "Try again.",
  });
  return false;
}
