import type { ScopedThreadRef } from "@t3tools/contracts";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { checkoutChangeBlock } from "./projectPage.logic";

interface CheckoutTarget {
  readonly threadRef: ScopedThreadRef;
  readonly draftId?: string | null | undefined;
  readonly isServerThread: boolean;
}

/** `checkoutChangeBlock` for a thread or draft, from the state loaded now. */
export function readCheckoutChangeBlock(target: CheckoutTarget) {
  return checkoutChangeBlock({
    draftId: target.draftId ?? null,
    serverThread: target.isServerThread ? (readThreadShell(target.threadRef) ?? undefined) : null,
    settings:
      appAtomRegistry.get(serverEnvironment.settingsValueAtom(target.threadRef.environmentId)) ??
      undefined,
  });
}

/**
 * Every change to where a thread runs, or to the branch its folder is on, asks here first. Returns
 * true, after saying why unless `quiet`, when the change is refused.
 */
export function refuseCheckoutChange(target: CheckoutTarget, quiet = false): boolean {
  const block = readCheckoutChangeBlock(target);
  if (block === null) return false;
  if (!quiet) {
    toastManager.add(
      stackedThreadToast(
        block === "project-chat"
          ? {
              type: "info",
              title: "The project's chat stays on the project folder as it is",
              description: "Switch the folder's branch in a terminal or another thread.",
            }
          : { type: "info", title: "Still loading this thread's machine. Try again in a moment." },
      ),
    );
  }
  return true;
}
