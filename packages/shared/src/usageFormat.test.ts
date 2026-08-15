// @effect-diagnostics globalDate:off -- A fixed instant keeps calendar-window assertions deterministic.
import { describe, expect, it, vi } from "vite-plus/test";

import {
  estimateUsageEmissionsGrams,
  enumerateHourStarts,
  formatEmissionsGrams,
  formatDateTimeShort,
  formatHourShort,
  formatRelativeHourShort,
  formatUsageEmissionsComparison,
  makeWindow,
} from "./usageFormat.ts";

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
  it("enumerates 24 fixed buckets across a rolling window", () => {
    const hours = enumerateHourStarts("2026-08-10T12:37:00.000Z", "2026-08-11T12:37:00.000Z");

    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe("2026-08-10T12:37:00.000Z");
    expect(hours[23]).toBe("2026-08-11T11:37:00.000Z");
  });

  it("formats rolling instants in the requested time zone", () => {
    expect(formatHourShort("2026-08-11T00:37:00.000Z", "UTC")).toBe("12 AM");
    expect(formatHourShort("2026-08-11T12:37:00.000Z", "UTC")).toBe("12 PM");
    expect(formatDateTimeShort("2026-08-11T17:37:00.000Z", "UTC")).toBe("Aug 11, 5 PM");
  });

  it("disambiguates repeated hours during a fall-back transition", () => {
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York")).toBe("1 AM EDT");
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York")).toBe("1 AM EST");
  });

  it("makes hourly tooltip dates relative to the window in its requested time zone", () => {
    const windowEnd = "2026-08-11T14:37:00.000Z";

    expect(formatRelativeHourShort("2026-08-10T17:37:00.000Z", windowEnd, "UTC")).toBe(
      "5 PM yesterday",
    );
    expect(formatRelativeHourShort("2026-08-11T14:37:00.000Z", windowEnd, "UTC")).toBe(
      "2 PM today",
    );
    expect(
      formatRelativeHourShort(
        "2026-08-11T01:37:00.000Z",
        "2026-08-11T10:37:00.000Z",
        "America/Los_Angeles",
      ),
    ).toBe("6 PM yesterday");
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
