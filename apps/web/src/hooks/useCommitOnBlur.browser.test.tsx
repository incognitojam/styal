import { type ChangeEvent, useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { useCommitOnBlur } from "./useCommitOnBlur";

let input: ReturnType<typeof useCommitOnBlur>;

function InputProbe(props: { value: string; onCommit: (next: string) => void | Promise<boolean> }) {
  const bag = useCommitOnBlur(props.value, props.onCommit);
  useLayoutEffect(() => {
    input = bag;
  });
  return null;
}

const probe = (value: string, onCommit: (next: string) => void | Promise<boolean>) => (
  <InputProbe value={value} onCommit={onCommit} />
);

async function edit(text: string) {
  await act(() => input.onFocus());
  await act(() => input.onChange({ target: { value: text } } as ChangeEvent<HTMLInputElement>));
  await act(() => input.onBlur());
}

function deferredSave() {
  let settle: (saved: boolean) => void = () => {};
  const promise = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

describe("useCommitOnBlur", () => {
  it("keeps the committed text while the save is in flight", async () => {
    const save = deferredSave();
    const onCommit = vi.fn(() => save.promise);
    await using screen = await render(probe("", onCommit));

    await edit("~/work");
    expect(onCommit).toHaveBeenCalledWith("~/work");
    expect(input.value).toBe("~/work");

    // The saved value arrives from the server.
    await screen.rerender(probe("~/work", onCommit));
    await act(() => save.settle(true));
    expect(input.value).toBe("~/work");
  });

  it("returns to the saved value when the save fails", async () => {
    const save = deferredSave();
    await using _screen = await render(probe("~/old", () => save.promise));

    await edit("~/new");
    expect(input.value).toBe("~/new");

    await act(() => save.settle(false));
    expect(input.value).toBe("~/old");
  });

  it("does not save again when refocused and left unchanged while saving", async () => {
    const save = deferredSave();
    const onCommit = vi.fn(() => save.promise);
    await using _screen = await render(probe("", onCommit));

    await edit("~/work");
    await act(() => input.onFocus());
    expect(input.value).toBe("~/work");
    await act(() => input.onBlur());

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("~/work");
  });

  it("shows the current value right away when the commit does not report a save", async () => {
    await using _screen = await render(probe("~/old", () => {}));

    await edit("~/new");
    expect(input.value).toBe("~/old");
  });
});
import { userEvent } from "vite-plus/test/browser";

import { resolvePastedPath } from "@t3tools/shared/path";

import { DraftInput } from "../components/ui/draft-input";

describe("settings draft commits", () => {
  it("preserves an external update when an untouched field loses focus", async () => {
    let saved = "~/";
    const commit = (next: string) => {
      saved = next;
    };
    await using screen = await render(<DraftInput value={saved} onCommit={commit} />);
    const input = screen.getByRole("textbox");
    await input.click();

    saved = "/projects";
    await screen.rerender(<DraftInput value={saved} onCommit={commit} />);
    await userEvent.tab();

    expect(saved).toBe("/projects");
  });

  it("preserves a saved edit when refocused before its server snapshot arrives", async () => {
    let saved = "~/";
    const commit = (next: string) => {
      saved = next;
    };
    await using screen = await render(<DraftInput value="~/" onCommit={commit} />);
    const input = screen.getByRole("textbox");
    await input.fill("/projects");
    await userEvent.tab();
    expect(saved).toBe("/projects");

    await input.click();
    await screen.rerender(<DraftInput value={saved} onCommit={commit} />);
    await userEvent.tab();

    expect(saved).toBe("/projects");
  });

  it("normalizes each change against the draft before it", async () => {
    let saved = "/mnt/old/";
    const commit = (next: string) => {
      saved = next;
    };
    await using screen = await render(
      <DraftInput value={saved} onCommit={commit} normalizeDraft={resolvePastedPath} />,
    );
    const input = screen.getByRole("textbox");
    await input.fill("/mnt/old//mnt/new");
    await userEvent.tab();
    expect(saved).toBe("/mnt/new");

    await input.fill("");
    await userEvent.type(input, "/tmp/a\\ b");
    await userEvent.tab();
    expect(saved).toBe("/tmp/a\\ b");
  });
});
