import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { ImportSourceView } from "./ImportDataView";

it("keeps a source project's last-active age counting while the preview stays open", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(new Date("2026-07-02T00:03:00Z"));
  await using screen = await render(
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
  );
  expect(screen.container.textContent).toContain("3m ago");

  await act(() => vi.advanceTimersByTime(60_000));
  expect(screen.container.textContent).toContain("4m ago");
});
