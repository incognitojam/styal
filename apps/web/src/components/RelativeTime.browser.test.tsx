import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { RelativeTime } from "./RelativeTime";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:03:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("advances a compiled relative time label without changing its timestamp or rerendering its parent", () => {
  act(() => root.render(<RelativeTime timestamp="2026-01-01T00:00:00Z" />));
  expect(container.textContent).toBe("3m ago");

  act(() => vi.advanceTimersByTime(59_999));
  expect(container.textContent).toBe("3m ago");

  act(() => vi.advanceTimersByTime(1));
  expect(container.textContent).toBe("4m ago");

  act(() => vi.advanceTimersByTime(60_000));
  expect(container.textContent).toBe("5m ago");
});
