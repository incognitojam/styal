import { describe, expect, it } from "vite-plus/test";

import { shouldOpenLinkInIntegratedBrowser } from "./loopbackLinkPreview";

const plainClick = { metaKey: false, ctrlKey: false };

function decide(
  href: string,
  overrides?: { event?: typeof plainClick; canOpenInPreview?: boolean },
) {
  return shouldOpenLinkInIntegratedBrowser({
    href,
    event: overrides?.event ?? plainClick,
    canOpenInPreview: overrides?.canOpenInPreview ?? true,
  });
}

describe("chat loopback link preview", () => {
  it.each([
    "http://localhost:5173",
    "http://localhost:5173/settings?tab=general#anchor",
    "http://127.0.0.1:3000/",
    "http://[::1]:8080/",
    "https://localhost:4321/",
  ])("opens %s in the integrated browser", (href) => {
    expect(decide(href)).toBe(true);
  });

  it.each([
    "https://github.com/incognitojam/t3code/issues/1",
    "https://example.com/localhost:5173",
    "https://localhost.example.com/",
    "http://192.168.1.4:5173/",
    "mailto:someone@example.com",
    "vscode://file/tmp/notes.md",
    "not a url",
  ])("leaves %s to the system browser", (href) => {
    expect(decide(href)).toBe(false);
  });

  it.each([
    ["meta", { metaKey: true, ctrlKey: false }],
    ["ctrl", { metaKey: false, ctrlKey: true }],
  ])("lets a %s click follow the link itself", (_modifier, event) => {
    expect(decide("http://localhost:5173", { event })).toBe(false);
  });

  it("leaves loopback alone where the integrated browser cannot be opened", () => {
    expect(decide("http://localhost:5173", { canOpenInPreview: false })).toBe(false);
  });
});
