import { act, type ChangeEvent, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useCommitOnBlur } from "./useCommitOnBlur";

let root: Root;
let input: ReturnType<typeof useCommitOnBlur>;

function InputProbe(props: { value: string; onCommit: (next: string) => void | Promise<boolean> }) {
  const bag = useCommitOnBlur(props.value, props.onCommit);
  useLayoutEffect(() => {
    input = bag;
  });
  return null;
}

const render = (value: string, onCommit: (next: string) => void | Promise<boolean>) =>
  act(() => root.render(<InputProbe value={value} onCommit={onCommit} />));

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

beforeEach(() => {
  // The probe has no DOM output, but ReactDOM needs an event target.
  const document = {
    nodeType: 9,
    addEventListener() {},
    removeEventListener() {},
  };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("useCommitOnBlur", () => {
  it("keeps the committed text while the save is in flight", async () => {
    const save = deferredSave();
    const onCommit = vi.fn(() => save.promise);
    await render("", onCommit);

    await edit("~/work");
    expect(onCommit).toHaveBeenCalledWith("~/work");
    expect(input.value).toBe("~/work");

    // The saved value arrives from the server.
    await render("~/work", onCommit);
    await act(() => save.settle(true));
    expect(input.value).toBe("~/work");
  });

  it("returns to the saved value when the save fails", async () => {
    const save = deferredSave();
    await render("~/old", () => save.promise);

    await edit("~/new");
    expect(input.value).toBe("~/new");

    await act(() => save.settle(false));
    expect(input.value).toBe("~/old");
  });

  it("does not save again when refocused and left unchanged while saving", async () => {
    const save = deferredSave();
    const onCommit = vi.fn(() => save.promise);
    await render("", onCommit);

    await edit("~/work");
    await act(() => input.onFocus());
    expect(input.value).toBe("~/work");
    await act(() => input.onBlur());

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("~/work");
  });

  it("shows the current value right away when the commit does not report a save", async () => {
    await render("~/old", () => {});

    await edit("~/new");
    expect(input.value).toBe("~/old");
  });
});
