import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
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

function setup() {
  vi.clearAllMocks();
}

const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find(
    (element) => element.ariaLabel === name || element.textContent === name,
  );

describe("saved diff comment editing", () => {
  it("starts an edit from a saved comment", async () => {
    setup();
    await using screen = await render(
      <DiffCommentAnnotation
        kind="comment"
        rangeLabel="+78"
        text="Original comment"
        {...callbacks}
        edit={edit}
      />,
    );

    expect(screen.container.textContent).toContain("Original comment");
    await act(() => button(screen.container, "Edit comment")!.click());
    expect(edit.onStart).toHaveBeenCalledOnce();
  });

  it("saves the controlled edit text instead of posting a new comment", async () => {
    setup();
    await using screen = await render(
      <DiffCommentAnnotation
        kind="comment"
        rangeLabel="+78"
        text="Original comment"
        {...callbacks}
        edit={{ ...edit, active: true, text: "  Revised comment  " }}
      />,
    );

    expect(screen.container.querySelector("textarea")!.value).toBe("  Revised comment  ");
    expect(screen.container.textContent).toContain("⌘/Ctrl Enter to save");
    await act(() => button(screen.container, "Save")!.click());
    expect(edit.onSave).toHaveBeenCalledExactlyOnceWith("Revised comment");
    expect(callbacks.onComment).not.toHaveBeenCalled();

    await act(() => button(screen.container, "Cancel")!.click());
    expect(edit.onCancel).toHaveBeenCalledOnce();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
  });
});
