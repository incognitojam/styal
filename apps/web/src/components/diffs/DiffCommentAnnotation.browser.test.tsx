import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DiffCommentAnnotation } from "./DiffCommentAnnotation";

const edit = {
  active: false,
  text: "",
  onStart: vi.fn(),
  onChange: vi.fn(),
  onCancel: vi.fn(),
  onSave: vi.fn(),
};
const callbacks = {
  onTextChange: vi.fn(),
  onCancel: vi.fn(),
  onComment: vi.fn(),
  onDelete: vi.fn(),
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (element) => element.ariaLabel === name || element.textContent === name,
  );

describe("saved diff comment editing", () => {
  it("starts an edit from a saved comment", async () => {
    await act(() =>
      root.render(
        <DiffCommentAnnotation
          kind="comment"
          rangeLabel="+78"
          text="Original comment"
          {...callbacks}
          edit={edit}
        />,
      ),
    );

    expect(container.textContent).toContain("Original comment");
    await act(() => button("Edit comment")!.click());
    expect(edit.onStart).toHaveBeenCalledOnce();
  });

  it("saves the controlled edit text instead of posting a new comment", async () => {
    await act(() =>
      root.render(
        <DiffCommentAnnotation
          kind="comment"
          rangeLabel="+78"
          text="Original comment"
          {...callbacks}
          edit={{ ...edit, active: true, text: "  Revised comment  " }}
        />,
      ),
    );

    expect(container.querySelector("textarea")!.value).toBe("  Revised comment  ");
    expect(container.textContent).toContain("⌘/Ctrl Enter to save");
    await act(() => button("Save")!.click());
    expect(edit.onSave).toHaveBeenCalledExactlyOnceWith("Revised comment");
    expect(callbacks.onComment).not.toHaveBeenCalled();

    await act(() => button("Cancel")!.click());
    expect(edit.onCancel).toHaveBeenCalledOnce();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
  });
});
