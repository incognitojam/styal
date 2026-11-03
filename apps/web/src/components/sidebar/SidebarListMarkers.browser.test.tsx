import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { attachSidebarTree } from "../../lib/sidebarTree";
import { SidebarProjectGroupHeader } from "./SidebarListMarkers";

it("keeps the project group header in the arrow keys and Tab order of the sidebar list", async () => {
  const onContextMenu = vi.fn();
  await using _screen = await render(
    <DndContext>
      <SortableContext items={["project:synthetic"]}>
        <ul ref={attachSidebarTree} role="presentation">
          <li>
            <button type="button" data-sidebar-row="thread:before">
              Before
            </button>
          </li>
          <SidebarProjectGroupHeader
            id="project:synthetic"
            group="synthetic"
            project={null}
            label="Synthetic project"
            pinned={false}
            draggable
            onContextMenu={onContextMenu}
          />
          <li>
            <button type="button" data-sidebar-row="thread:after">
              After
            </button>
          </li>
        </ul>
      </SortableContext>
    </DndContext>,
    { router: false }, // The header reads no route state.
  );
  const before = page.getByRole("button", { name: "Before" }).element() as HTMLElement;
  const header = page.getByRole("button", { name: "Synthetic project" }).element();
  const after = page.getByRole("button", { name: "After" }).element();

  before.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(header);
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(after);
  await userEvent.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(header);

  before.focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(header);

  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  expect(onContextMenu).toHaveBeenCalledWith("synthetic", expect.anything());
});
