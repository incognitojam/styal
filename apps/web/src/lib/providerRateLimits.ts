import type { ServerProvider } from "@t3tools/contracts";

/**
 * One subscription quota window prepared for display: a human name, when it
 * resets, and how much is spent. Providers report windows sparsely, so both
 * `resetText` and `usedPercent` can be absent for a window we still know of.
 */
export interface ProviderRateLimitRow {
  readonly id: string;
  readonly name: string;
  readonly resetText: string | null;
  readonly usedPercent: number | null;
}

function windowName(window: NonNullable<ServerProvider["rateLimits"]>["windows"][number]): string {
  if (window.label) return `${window.label} limit`;
  if (window.windowMinutes === undefined) return window.id;
  const hours = Math.round(window.windowMinutes / 60);
  if (hours < 24) return `${hours}-hour limit`;
  const days = Math.round(hours / 24);
  return days === 7 ? "Weekly limit" : `${days}-day limit`;
}

/**
 * Grace period for a window whose reset instant has passed. Absorbs clock
 * skew between the provider's reset timestamps and the client clock; past
 * it the window has genuinely rolled over and its usage figure is stale.
 */
const RESET_GRACE_MS = 60_000;

function hasExpired(resetsAt: number, now: number): boolean {
  return resetsAt * 1000 - now < -RESET_GRACE_MS;
}

function resetText(resetsAt: number, now: number): string {
  const remainingMs = resetsAt * 1000 - now;
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
  rateLimits: ServerProvider["rateLimits"],
  now: number,
): ReadonlyArray<ProviderRateLimitRow> {
  if (!rateLimits) return [];
  return rateLimits.windows
    .filter((window) => window.resetsAt === undefined || !hasExpired(window.resetsAt, now))
    .map((window) => ({
      id: window.id,
      name: windowName(window),
      resetText: window.resetsAt !== undefined ? resetText(window.resetsAt, now) : null,
      usedPercent: window.usedPercent ?? null,
    }));
}
