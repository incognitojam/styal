import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { COMPOSER_CONTEXT_CLIPBOARD_MIME } from "@t3tools/shared/composerContextClipboard";

import {
  ClipboardWriteError,
  clipboardWriteEpoch,
  ensureClipboardEpochTracking,
  writeTextToClipboard,
  writeResolvedTextToClipboard,
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

  it("starts an asynchronous clipboard write before path resolution and advances only on success", async () => {
    let resolvePath!: (path: string) => void;
    const path = new Promise<string>((resolve) => {
      resolvePath = resolve;
    });
    let contents: Record<string, Promise<Blob>> = {};
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(value: Record<string, Promise<Blob>>) {
          contents = value;
        }
      },
    );
    const write = vi.fn(async () => {
      await contents["text/plain"];
    });
    vi.stubGlobal("navigator", { clipboard: { write } });
    const before = clipboardWriteEpoch();
    const pending = writeResolvedTextToClipboard(path);
    expect(write).toHaveBeenCalledOnce();
    expect(clipboardWriteEpoch()).toBe(before);
    resolvePath("/workspace/example.ts");
    await pending;
    expect(await (await contents["text/plain"]!).text()).toBe("/workspace/example.ts");
    expect(clipboardWriteEpoch()).toBe(before + 1);
    write.mockRejectedValueOnce(new Error("denied"));
    await expect(writeResolvedTextToClipboard(Promise.resolve("blocked"))).rejects.toThrow(
      "denied",
    );
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

describe("writeTextToClipboard", () => {
  it("includes the browser failure reason in the surfaced error", async () => {
    const cause = new Error("Document is not focused.");
    stubClipboardWriteText(() => Promise.reject(cause));

    await expect(writeTextToClipboard("hello")).rejects.toMatchObject({
      message: "Failed to copy text to the clipboard: Document is not focused.",
      cause,
    });
  });

  it("keeps the generic message when the rejection has no useful detail", async () => {
    stubClipboardWriteText(() => Promise.reject(undefined));

    await expect(writeTextToClipboard("hello")).rejects.toMatchObject({
      message: "Failed to copy text to the clipboard.",
    });
  });

  it("reserves plain text even when an extra flavor attempts to replace it", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Blob>) {}
      },
    );
    await expect(
      writeTextToClipboard("original", "message", {
        "text/plain": "replacement",
        "text/html": "<b>original</b>",
      }),
    ).resolves.toBe(true);
    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
    expect(await items[0]!.data["text/plain"]!.text()).toBe("original");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps caller-built rich HTML when attaching a context fragment", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Blob>) {}
      },
    );
    const fragment = JSON.stringify({ version: 1, source: {}, records: [] });
    const rich = "<p><strong>Message</strong></p>";

    await expect(
      writeTextToClipboard("Message", "message", {
        [COMPOSER_CONTEXT_CLIPBOARD_MIME]: fragment,
        "text/html": rich,
      }),
    ).resolves.toBe(true);

    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
    const html = await items[0]!.data["text/html"]!.text();
    expect(html).toContain(rich);
    expect(html).toContain("data-t3-context-fragment=");
  });

  it("preserves the exact clipboard failure without exposing copied contents", async () => {
    const cause = new Error("browser clipboard failure");
    const writeText = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const error = await writeTextToClipboard("secret clipboard contents", "error-message").then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(writeText).toHaveBeenCalledWith("secret clipboard contents");
    expect(error).toBeInstanceOf(ClipboardWriteError);
    expect(error).toMatchObject({
      target: "error-message",
      cause,
    });
    expect((error as Error).message).not.toContain("secret clipboard contents");
  });
});
