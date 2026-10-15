// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./SettingsScopeSentence", () => ({
  SettingsScopeSentence: function Sentence({ compact }: { compact: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(!open)}>
          {compact ? "Project" : "Applying settings for"}
        </button>
        {open ? <input aria-label="Project menu search" /> : null}
      </>
    );
  },
}));

import {
  SettingsScopeDockProvider,
  SettingsScopeInline,
  SettingsScopeToolbar,
} from "./SettingsScopeDock";

let root: Root;
let container: HTMLDivElement;
let resize: () => void;
let sourceTop: number;
let sourceHeight: number;
let disconnect: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  disconnect = vi.fn();
  sourceTop = 24;
  sourceHeight = 24;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const scroll = container.querySelector<HTMLElement>("[data-settings-page-scroll]");
    return this.hasAttribute("data-settings-scope-source")
      ? new DOMRect(0, sourceTop - (scroll?.scrollTop ?? 0), 400, sourceHeight)
      : new DOMRect(0, 0, 400, 600);
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => {
    root.render(
      <SettingsScopeDockProvider enabled>
        <header>
          <SettingsScopeToolbar />
        </header>
        <div data-settings-page-scroll>
          <SettingsScopeInline />
        </div>
      </SettingsScopeDockProvider>,
    );
  });
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function scrollTo(top: number) {
  await act(() => {
    const scroll = container.querySelector<HTMLElement>("[data-settings-page-scroll]")!;
    scroll.scrollTop = top;
    scroll.dispatchEvent(new Event("scroll"));
  });
}

describe("settings scope docking", () => {
  it("moves the same controls into the toolbar and back without losing their state", async () => {
    const button = container.querySelector("button")!;
    const source = container.querySelector<HTMLElement>("[data-settings-scope-source]")!;
    expect(source.contains(button)).toBe(true);

    await act(() => button.click());
    const search = container.querySelector<HTMLInputElement>("input")!;
    search.value = "demo";
    search.focus();

    await scrollTo(50);

    expect(container.querySelector("header")!.contains(button)).toBe(true);
    expect(container.querySelector("input")).toBe(search);
    expect(search.value).toBe("demo");
    expect(document.activeElement).toBe(search);
    expect(source.style.height).toBe("24px");

    await scrollTo(0);

    expect(source.contains(button)).toBe(true);
    expect(container.querySelector("input")).toBe(search);
    expect(document.activeElement).toBe(search);
    expect(source.style.height).toBe("");
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("keeps the original position while visible or below the viewport and disconnects on unmount", async () => {
    const source = container.querySelector("[data-settings-scope-source]")!;
    await scrollTo(30);
    expect(source.contains(container.querySelector("button"))).toBe(true);
    sourceTop = 800;
    await act(() => resize());
    expect(source.contains(container.querySelector("button"))).toBe(true);

    await act(() => root.render(null));
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("updates the docking threshold when the inline sentence wraps", async () => {
    const source = container.querySelector("[data-settings-scope-source]")!;
    sourceHeight = 52;
    await act(() => resize());

    await scrollTo(60);
    expect(source.contains(container.querySelector("button"))).toBe(true);

    await scrollTo(80);
    expect(container.querySelector("header")!.contains(container.querySelector("button"))).toBe(
      true,
    );
    expect((source as HTMLElement).style.height).toBe("52px");
  });
});
