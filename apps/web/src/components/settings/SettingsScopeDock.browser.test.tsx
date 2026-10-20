import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";

const motion = vi.hoisted(() => ({
  start: vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({ cancel: vi.fn() })),
}));

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

function fixture(pageKey = "initial") {
  return (
    <SettingsScopeDockProvider enabled>
      <header>
        <SettingsScopeToolbar />
      </header>
      {/* Real overflow, so assigning scrollTop moves the page. */}
      <div key={pageKey} data-settings-page-scroll style={{ height: 600, overflowY: "auto" }}>
        <SettingsScopeInline />
        <div style={{ height: 2000 }} />
      </div>
    </SettingsScopeDockProvider>
  );
}

async function mount() {
  await using stack = new AsyncDisposableStack();
  const layout = { sourceTop: 24, sourceHeight: 24, reducedMotion: false };
  const disconnect = vi.fn();
  let resize = () => {};
  motion.start.mockClear();
  const container = document.createElement("div");
  stack.use(stubGlobal("matchMedia", () => ({ matches: layout.reducedMotion })));
  stack.use(
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const scroll = container.querySelector<HTMLElement>("[data-settings-page-scroll]");
      return this.hasAttribute("data-settings-scope-source")
        ? new DOMRect(0, layout.sourceTop - (scroll?.scrollTop ?? 0), 400, layout.sourceHeight)
        : new DOMRect(0, 0, 400, 600);
    }),
  );
  stack.use(
    stubGlobal(
      "ResizeObserver",
      class {
        readonly observed = new Set<Element>();
        constructor(callback: ResizeObserverCallback) {
          resize = () =>
            callback(
              [...this.observed].map(
                (target) =>
                  ({ target, contentRect: target.getBoundingClientRect() }) as ResizeObserverEntry,
              ),
              this as unknown as ResizeObserver,
            );
        }
        observe(target: Element) {
          this.observed.add(target);
        }
        unobserve(target: Element) {
          this.observed.delete(target);
        }
        disconnect = disconnect;
      },
    ),
  );
  const screen = stack.use(await render(fixture(), { container }));
  const host = container.querySelector("[data-settings-scope-source]")!.firstElementChild!;
  Object.assign(host, { animate: motion.start });
  const resources = stack.move();
  return {
    container,
    layout,
    disconnect,
    resize: () => resize(),
    rerender: screen.rerender,
    scrollTo: (top: number) =>
      act(() => {
        const scroll = container.querySelector<HTMLElement>("[data-settings-page-scroll]")!;
        scroll.scrollTop = top;
        scroll.dispatchEvent(new Event("scroll"));
      }),
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}

describe("settings scope docking", () => {
  it("replaces page content without entrance motion and still animates subsequent scrolling", async () => {
    await using dock = await mount();
    const button = dock.container.querySelector("button")!;
    for (const page of ["general", "providers", "general-again"]) {
      await dock.rerender(fixture(page));
      expect(dock.container.querySelector("[data-settings-scope-source]")!.contains(button)).toBe(
        true,
      );
    }
    expect(motion.start).not.toHaveBeenCalled();

    await dock.scrollTo(50);
    expect(dock.container.querySelector("header")!.contains(button)).toBe(true);
    expect(motion.start).toHaveBeenCalledOnce();

    await dock.rerender(fixture("replacement-while-docked"));
    expect(dock.container.querySelector("[data-settings-scope-source]")!.contains(button)).toBe(
      true,
    );
    expect(motion.start).toHaveBeenCalledOnce();
    await dock.scrollTo(50);
    expect(motion.start).toHaveBeenCalledTimes(2);
  });

  it("establishes placement after layout changes without animating", async () => {
    await using dock = await mount();
    dock.layout.sourceTop = -60;
    await act(() => dock.resize());
    expect(
      dock.container.querySelector("header")!.contains(dock.container.querySelector("button")),
    ).toBe(true);
    dock.layout.sourceTop = 24;
    await act(() => dock.resize());
    expect(
      dock.container
        .querySelector("[data-settings-scope-source]")!
        .contains(dock.container.querySelector("button")),
    ).toBe(true);
    expect(motion.start).not.toHaveBeenCalled();
  });

  it("animates only threshold crossings and cancels interrupted motion", async () => {
    await using dock = await mount();
    expect(motion.start).not.toHaveBeenCalled();
    await dock.scrollTo(850);
    expect(motion.start).toHaveBeenCalledOnce();
    const [frames] = motion.start.mock.calls[0]!;
    expect(frames[0]?.transform).toBe("translateY(8px)");
    const first = motion.start.mock.results[0]!.value;

    await dock.scrollTo(900);
    expect(motion.start).toHaveBeenCalledOnce();

    await dock.scrollTo(0);
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(motion.start).toHaveBeenCalledTimes(2);
    const second = motion.start.mock.results[1]!.value;
    await dock.rerender(null);
    expect(second.cancel).toHaveBeenCalledOnce();
  });

  it("moves the controls immediately in both directions with reduced motion", async () => {
    await using dock = await mount();
    dock.layout.reducedMotion = true;
    const button = dock.container.querySelector("button")!;
    await dock.scrollTo(50);
    expect(dock.container.querySelector("header")!.contains(button)).toBe(true);
    await dock.scrollTo(0);
    expect(dock.container.querySelector("[data-settings-scope-source]")!.contains(button)).toBe(
      true,
    );
    expect(motion.start).not.toHaveBeenCalled();
  });

  it("moves the same controls into the toolbar and back without losing their state", async () => {
    await using dock = await mount();
    const button = dock.container.querySelector("button")!;
    const source = dock.container.querySelector<HTMLElement>("[data-settings-scope-source]")!;
    expect(source.contains(button)).toBe(true);

    await act(() => button.click());
    const search = dock.container.querySelector<HTMLInputElement>("input")!;
    search.value = "demo";
    search.focus();

    await dock.scrollTo(50);

    expect(dock.container.querySelector("header")!.contains(button)).toBe(true);
    expect(dock.container.querySelector("input")).toBe(search);
    expect(search.value).toBe("demo");
    expect(document.activeElement).toBe(search);
    expect(source.style.height).toBe("24px");

    await dock.scrollTo(0);

    expect(source.contains(button)).toBe(true);
    expect(dock.container.querySelector("input")).toBe(search);
    expect(document.activeElement).toBe(search);
    expect(source.style.height).toBe("");
    expect(dock.container.querySelectorAll("button")).toHaveLength(1);
  });

  it("keeps the original position while visible or below the viewport and disconnects on unmount", async () => {
    await using dock = await mount();
    const source = dock.container.querySelector("[data-settings-scope-source]")!;
    await dock.scrollTo(30);
    expect(source.contains(dock.container.querySelector("button"))).toBe(true);
    dock.layout.sourceTop = 800;
    await act(() => dock.resize());
    expect(source.contains(dock.container.querySelector("button"))).toBe(true);

    await dock.rerender(null);
    expect(dock.disconnect).toHaveBeenCalledOnce();
  });

  it("updates the docking threshold when the inline sentence wraps", async () => {
    await using dock = await mount();
    const source = dock.container.querySelector("[data-settings-scope-source]")!;
    dock.layout.sourceHeight = 52;
    await act(() => dock.resize());

    await dock.scrollTo(60);
    expect(source.contains(dock.container.querySelector("button"))).toBe(true);

    await dock.scrollTo(80);
    expect(
      dock.container.querySelector("header")!.contains(dock.container.querySelector("button")),
    ).toBe(true);
    expect((source as HTMLElement).style.height).toBe("52px");
  });
});
