import { describe, expect, it } from "vite-plus/test";

import { redactedPlaceholder } from "./redactedText.ts";

describe("redactedPlaceholder", () => {
  it("keeps the shape of the value without revealing its characters", () => {
    const value = "dev.user@example.com";
    const placeholder = redactedPlaceholder(value);

    expect(placeholder).toHaveLength(value.length);
    expect(placeholder.replace(/[^@.\-_]/g, "")).toBe(".@.");
    expect(placeholder).not.toContain("dev");
    expect(placeholder).not.toContain("example");
  });

  it("gives the same value the same placeholder", () => {
    expect(redactedPlaceholder("a@b.co")).toBe(redactedPlaceholder("a@b.co"));
    expect(redactedPlaceholder("a@b.co")).not.toBe(redactedPlaceholder("c@b.co"));
  });
});
