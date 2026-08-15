import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clipboardWriteEpoch,
  ensureClipboardEpochTracking,
  writeTextToClipboard,
} from "./useCopyToClipboard";

// Tests run in a node environment; stub the browser globals the module reads.
function stubClipboardWriteText(implementation: () => Promise<void>) {
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { clipboard: { writeText: implementation } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clipboardWriteEpoch", () => {
  it("advances on a successful write and not on a failed one", async () => {
    stubClipboardWriteText(() => Promise.resolve());
    const before = clipboardWriteEpoch();
    await writeTextToClipboard("hello");
    expect(clipboardWriteEpoch()).toBe(before + 1);

    stubClipboardWriteText(() => Promise.reject(new Error("denied")));
    await expect(writeTextToClipboard("blocked")).rejects.toThrow();
    expect(clipboardWriteEpoch()).toBe(before + 1);
  });

  it("does not advance for an empty value, which is never written", async () => {
    stubClipboardWriteText(() => Promise.resolve());
    const before = clipboardWriteEpoch();
    await writeTextToClipboard("");
    expect(clipboardWriteEpoch()).toBe(before);
  });

  it("advances on DOM copy events once tracking is installed", () => {
    const documentStub = new EventTarget();
    vi.stubGlobal("document", documentStub);
    ensureClipboardEpochTracking();
    const before = clipboardWriteEpoch();
    documentStub.dispatchEvent(new Event("copy"));
    expect(clipboardWriteEpoch()).toBe(before + 1);

    // Installing again must not double-count.
    ensureClipboardEpochTracking();
    documentStub.dispatchEvent(new Event("copy"));
    expect(clipboardWriteEpoch()).toBe(before + 2);
  });
});
