import { describe, expect, it } from "vite-plus/test";

import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
} from "./SidebarStageBackdrop";

describe("SidebarStageBackdrop", () => {
  it("resolves stage artwork only when enabled", () => {
    expect(resolveSidebarStageBackdropVariant("Dev")).toBe("dev");
    expect(resolveSidebarStageBackdropVariant("Nightly")).toBe("nightly");
    expect(resolveSidebarStageBackdropVariant("Preview")).toBe("dev");
    expect(resolveSidebarStageBackdropVariant("Dev", "none")).toBeNull();
    expect(resolveSidebarStageBackdropVariant("Dev", "pill")).toBeNull();
    expect(resolveSidebarStageBackdropVariant("Stable")).toBeNull();
    expect(resolveSidebarStageBackdropVariant("Stable", "nightly-artwork")).toBe("nightly");
    expect(resolveSidebarStageBackdropVariant("Nightly", "dev-artwork")).toBe("dev");
  });

  it("resolves supported environment pill labels", () => {
    expect(resolveEnvironmentIdentificationPillLabel("Dev")).toBe("Dev");
    expect(resolveEnvironmentIdentificationPillLabel("nightly")).toBe("Nightly");
    expect(resolveEnvironmentIdentificationPillLabel("Preview")).toBe("Preview");
    expect(resolveEnvironmentIdentificationPillLabel("Latest")).toBeNull();
    expect(resolveEnvironmentIdentificationPillLabel("Stable")).toBeNull();
  });
});
