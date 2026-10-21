import { describe, expect, it } from "vite-plus/test";

import { AUTO_SETTLE_DEFAULT_DAYS, resolveSettlementPatch } from "./settlement.logic";

describe("resolveSettlementPatch", () => {
  it("leaves a computer alone when it already matches the choice", () => {
    expect(
      resolveSettlementPatch(
        { sidebarAutoSettleOnMerge: true, sidebarAutoSettleAfterDays: 7 },
        { onMerge: true, whenInactive: true },
      ),
    ).toBeNull();
    expect(
      resolveSettlementPatch(
        { sidebarAutoSettleOnMerge: false, sidebarAutoSettleAfterDays: null },
        { onMerge: false, whenInactive: false },
      ),
    ).toBeNull();
  });

  it("keeps a computer's own inactivity threshold while changing merge settlement", () => {
    expect(
      resolveSettlementPatch(
        { sidebarAutoSettleOnMerge: true, sidebarAutoSettleAfterDays: 14 },
        { onMerge: false, whenInactive: true },
      ),
    ).toEqual({ sidebarAutoSettleOnMerge: false, sidebarAutoSettleAfterDays: 14 });
  });

  it("turns inactivity settlement off, and back on with the default threshold", () => {
    expect(
      resolveSettlementPatch(
        { sidebarAutoSettleOnMerge: true, sidebarAutoSettleAfterDays: 3 },
        { onMerge: true, whenInactive: false },
      ),
    ).toEqual({ sidebarAutoSettleOnMerge: true, sidebarAutoSettleAfterDays: null });
    expect(
      resolveSettlementPatch(
        { sidebarAutoSettleOnMerge: true, sidebarAutoSettleAfterDays: null },
        { onMerge: true, whenInactive: true },
      ),
    ).toEqual({
      sidebarAutoSettleOnMerge: true,
      sidebarAutoSettleAfterDays: AUTO_SETTLE_DEFAULT_DAYS,
    });
  });
});
