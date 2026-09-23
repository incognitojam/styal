import type { ServerProvider } from "@t3tools/contracts";
import { resetMillis } from "@t3tools/shared/usageLimits";

/**
 * One subscription quota window prepared for display: the provider's name for
 * it, when it resets, and how much is spent. `resetText` is absent when the
 * provider did not report a reset time.
 */
export interface ProviderRateLimitRow {
  readonly id: string;
  readonly name: string;
  readonly resetText: string | null;
  readonly usedPercent: number;
}

/**
 * Grace period for a window whose reset instant has passed. Absorbs clock
 * skew between the provider's reset timestamps and the client clock; past
 * it the window has genuinely rolled over and its usage figure is stale.
 */
const RESET_GRACE_MS = 60_000;

function hasExpired(resetsAt: number, now: number): boolean {
  return resetsAt - now < -RESET_GRACE_MS;
}

function resetText(resetsAt: number, now: number): string {
  const remainingMs = resetsAt - now;
  if (remainingMs < 60_000) return "Resets soon";
  const minutes = Math.round(remainingMs / 60_000);
  if (minutes < 60) return `Resets in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0
      ? `Resets in ${hours} hr ${remainingMinutes} min`
      : `Resets in ${hours} hr`;
  }
  const days = Math.round(hours / 24);
  return `Resets in ${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * Prepare a provider's reported quota windows for display. Shared by the
 * settings provider card and the composer's context window popover so both
 * name and time-format windows identically.
 *
 * Windows whose reset has already passed are dropped: the snapshot predates
 * the rollover, so its usage figure describes a window that no longer
 * exists. They return on the next successful refresh.
 */
export function deriveProviderRateLimitRows(
  usageLimits: ServerProvider["usageLimits"],
  now: number,
): ReadonlyArray<ProviderRateLimitRow> {
  if (!usageLimits) return [];
  return usageLimits.windows.flatMap((window) => {
    const resetsAt = resetMillis(window);
    if (resetsAt !== null && hasExpired(resetsAt, now)) return [];
    return [
      {
        id: window.id,
        name: window.label,
        resetText: resetsAt === null ? null : resetText(resetsAt, now),
        usedPercent: window.usedPercent,
      },
    ];
  });
}
