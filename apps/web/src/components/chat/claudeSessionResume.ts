import type { ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";

type ContinuationProvider = Pick<
  ProviderInstanceEntry,
  "instanceId" | "driverKind" | "continuationGroupKey"
>;

/**
 * Whether the next turn resumes the thread's native Claude session, which
 * resends its whole history. Switching from another provider, or to a Claude
 * instance with separate history, hands off a bounded summary instead, so the
 * thread's current context usage says nothing about what the next turn sends.
 * `currentInstanceId` is the instance the last turn ran on; `next` is the
 * instance that will run the next one.
 */
export function resumesClaudeSession(
  entries: ReadonlyArray<ContinuationProvider>,
  currentInstanceId: ProviderInstanceId | null | undefined,
  next: ContinuationProvider | null | undefined,
): boolean {
  const current = entries.find((entry) => entry.instanceId === currentInstanceId);
  if (current?.driverKind !== "claudeAgent" || next?.driverKind !== "claudeAgent") {
    return false;
  }
  return (
    current.instanceId === next.instanceId ||
    (current.continuationGroupKey !== undefined &&
      current.continuationGroupKey === next.continuationGroupKey)
  );
}
