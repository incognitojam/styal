import { describe, expect, it } from "vite-plus/test";

import {
  readPendingComposerAttachments,
  withPendingComposerAttachments,
} from "./composer-pending-attachments";

const PICKED = [
  { id: "a", previewUri: "file:///picked/a.jpg" },
  { id: "b", previewUri: null },
];

describe("withPendingComposerAttachments", () => {
  it("shows picked items until the result lands, then clears them in the same step", async () => {
    let releasePick!: () => void;
    const picking = new Promise<void>((resolve) => {
      releasePick = resolve;
    });
    let pendingWhenLanding: ReadonlyArray<unknown> | null = null;

    const run = withPendingComposerAttachments(
      "thread-1",
      async (onPicked) => {
        onPicked(PICKED);
        await picking;
        return "attachments";
      },
      (result) => {
        expect(result).toBe("attachments");
        pendingWhenLanding = readPendingComposerAttachments("thread-1");
      },
    );

    await Promise.resolve();
    expect(readPendingComposerAttachments("thread-1")).toEqual(PICKED);
    expect(readPendingComposerAttachments("thread-2")).toEqual([]);
    releasePick();
    await run;

    // The draft write and the placeholder removal happen without a render in between.
    expect(pendingWhenLanding).toEqual(PICKED);
    expect(readPendingComposerAttachments("thread-1")).toEqual([]);
  });

  it("clears picked items when processing fails", async () => {
    await expect(
      withPendingComposerAttachments(
        "thread-1",
        async (onPicked) => {
          onPicked(PICKED);
          throw new Error("could not read");
        },
        () => undefined,
      ),
    ).rejects.toThrow("could not read");
    expect(readPendingComposerAttachments("thread-1")).toEqual([]);
  });
});
