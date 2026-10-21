import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();

  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  globalThis.window = originalWindow;
});

describe("branding", () => {
  it("does not label the stable hosted app channel", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "latest");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBe("latest");
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBe("Stable");
    expect(branding.APP_STAGE_LABEL).toBe("Stable");
    expect(branding.APP_DISPLAY_NAME).toBe("styal");
  });
});
