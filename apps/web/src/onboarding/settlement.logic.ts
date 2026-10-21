import { DEFAULT_UNIFIED_SETTINGS, type ServerSettings } from "@t3tools/contracts";

export const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

export interface SettlementChoice {
  readonly onMerge: boolean;
  readonly whenInactive: boolean;
}

/**
 * The settings patch that applies a setup settlement choice to one computer, or null when it
 * already matches. Turning inactivity settlement on keeps that computer's own threshold.
 */
export function resolveSettlementPatch(
  settings: Pick<ServerSettings, "sidebarAutoSettleOnMerge" | "sidebarAutoSettleAfterDays">,
  choice: SettlementChoice,
) {
  const afterDays = choice.whenInactive
    ? (settings.sidebarAutoSettleAfterDays ?? AUTO_SETTLE_DEFAULT_DAYS)
    : null;
  if (
    settings.sidebarAutoSettleOnMerge === choice.onMerge &&
    settings.sidebarAutoSettleAfterDays === afterDays
  ) {
    return null;
  }
  return { sidebarAutoSettleOnMerge: choice.onMerge, sidebarAutoSettleAfterDays: afterDays };
}
