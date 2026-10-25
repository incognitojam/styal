import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { ImportSourceView } from "./ImportDataView";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-07-02T00:03:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps a source project's last-active age counting while the preview stays open", async () => {
  await act(async () =>
    root.render(
      <ImportSourceView
        disabled={false}
        source={{
          title: "T3 Code",
          pending: false,
          refresh: () => {},
          select: () => {},
          projects: [
            {
              id: "project-1",
              title: "synthetic-project",
              path: "/work/synthetic-project",
              threads: 2,
              selected: true,
              lastActiveAt: "2026-07-02T00:00:00Z",
            },
          ],
        }}
      />,
    ),
  );
  expect(container.textContent).toContain("3m ago");

  await act(async () => vi.advanceTimersByTime(60_000));
  expect(container.textContent).toContain("4m ago");
});
