// @effect-diagnostics globalDate:off -- A fixed instant keeps calendar-window assertions deterministic.
import { describe, expect, it, vi } from "vite-plus/test";

import {
  estimateUsageEmissionsGrams,
  formatEmissionsGrams,
  formatHourShort,
  formatTokens,
  formatUsageEmissionsComparison,
  makeWindow,
} from "./usageFormat.ts";

describe("formatTokens", () => {
  it("keeps three significant figures within a unit", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_234)).toBe("1.23K");
    expect(formatTokens(48_200)).toBe("48.2K");
    expect(formatTokens(999_400)).toBe("999K");
    expect(formatTokens(2_407_600)).toBe("2.41M");
  });

  it("moves up a unit when rounding reaches 1000", () => {
    expect(formatTokens(999.6)).toBe("1K");
    expect(formatTokens(999_900)).toBe("1M");
    expect(formatTokens(-999_900)).toBe("-1M");
    expect(formatTokens(999_700_000)).toBe("1B");
    expect(formatTokens(999_700_000_000)).toBe("1T");
  });
});

describe("usage emissions estimate", () => {
  it("estimates operational emissions from generated tokens", () => {
    expect(estimateUsageEmissionsGrams(1_000)).toBeCloseTo(0.4288, 4);
    expect(estimateUsageEmissionsGrams(-1)).toBe(0);
  });

  it("formats emissions across useful scales", () => {
    expect(formatEmissionsGrams(0)).toBe("0 g");
    expect(formatEmissionsGrams(0.4288)).toBe("429 mg");
    expect(formatEmissionsGrams(428.8)).toBe("429 g");
    expect(formatEmissionsGrams(4_288)).toBe("4.29 kg");
    expect(formatEmissionsGrams(4_288_000)).toBe("4.29 t");
  });

  it("uses phone charges for grams and driving distance for kilograms", () => {
    expect(formatUsageEmissionsComparison(0)).toBe("No estimated emissions");
    expect(formatUsageEmissionsComparison(1)).toBe("Less than one phone charge");
    expect(formatUsageEmissionsComparison(12.4)).toBe("About 1 phone charge");
    expect(formatUsageEmissionsComparison(660)).toBe("About 53 phone charges");
    expect(formatUsageEmissionsComparison(4_310)).toBe("About 11 miles driven");
    expect(formatUsageEmissionsComparison(8_250)).toBe("About 21 miles driven");
    expect(formatUsageEmissionsComparison(27_600)).toBe("About 70 miles driven");
  });
});

describe("hourly usage formatting", () => {
  it("keeps requested zones separate when formatting repeated calls", () => {
    const instant = "2026-08-11T12:37:00.000Z";
    for (const zone of ["UTC", "America/New_York", "Asia/Kathmandu", "UTC"]) {
      expect(formatHourShort(instant, zone)).toBe(
        new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric" }).format(
          new Date(instant),
        ),
      );
    }
    expect(() => formatHourShort(instant, "Etc/Unknown")).toThrow(RangeError);
    expect(formatHourShort("invalid", "UTC")).toBe("invalid");
  });

  it("disambiguates repeated hours during a fall-back transition", () => {
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York")).toBe("1 AM EDT");
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York")).toBe("1 AM EST");
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York", false)).toBe(
      "01:00 EDT",
    );
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York", false)).toBe(
      "01:00 EST",
    );
  });

  it("builds an exact minute-aligned 24-hour request", () => {
    const window = makeWindow(1, new Date("2026-08-11T12:37:42.123Z"), "hour");

    expect(window.resolution).toBe("hour");
    expect(window.sinceTime).toBe("2026-08-10T12:37:00.000Z");
    expect(window.untilTime).toBe("2026-08-11T12:37:00.000Z");
  });

  it("degrades an unknown resolved zone to UTC instead of crashing", () => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    const resolvedOptions = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolved, timeZone: "Etc/Unknown" });

    try {
      const now = new Date("2026-08-11T12:37:42.123Z");

      expect(makeWindow(1, now, "hour").timeZone).toBe("UTC");
      expect(makeWindow(30, now).timeZone).toBe("UTC");
    } finally {
      resolvedOptions.mockRestore();
    }
  });
});
