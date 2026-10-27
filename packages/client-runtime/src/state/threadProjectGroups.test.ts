import { describe, expect, it } from "vite-plus/test";

import {
  groupActiveThreadsByProject,
  groupWorkingThreadsByProject,
} from "./threadProjectGroups.ts";
import { planPinnedReorder, sortActiveThreadsByOrderKey } from "./threadSort.ts";

describe("groupWorkingThreadsByProject", () => {
  const group = (thread: { group: string }) => thread.group;
  const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

  it("keeps project order when a send makes another project's thread newest", () => {
    const newestFirst = [
      { id: "b1", group: "B" },
      { id: "a1", group: "A" },
      { id: "b2", group: "B" },
    ];
    const afterSendToA2 = [{ id: "a2", group: "A" }, ...newestFirst];

    expect(ids(groupWorkingThreadsByProject(newestFirst, group, ["A", "B"]))).toEqual([
      "a1",
      "b1",
      "b2",
    ]);
    expect(ids(groupWorkingThreadsByProject(afterSendToA2, group, ["A", "B", "A"]))).toEqual([
      "a2",
      "a1",
      "b1",
      "b2",
    ]);
  });
});

describe("groupActiveThreadsByProject", () => {
  const threads = [
    { id: "a1", group: "A", createdAt: "2026-10-01T10:03:00Z", activeOrderKey: null },
    { id: "b1", group: "B", createdAt: "2026-10-01T10:02:00Z", activeOrderKey: null },
    { id: "c1", group: "C", createdAt: "2026-10-01T10:01:00Z", activeOrderKey: null },
    { id: "a2", group: "A", createdAt: "2026-10-01T10:00:00Z", activeOrderKey: null },
  ];
  const group = (thread: { group: string }) => thread.group;
  const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

  it("keeps project placement after the first reorder materializes thread keys", () => {
    const before = groupActiveThreadsByProject(sortActiveThreadsByOrderKey(threads), group);
    const assignments = planPinnedReorder({
      orderedIds: ["a2", "a1"],
      keysById: new Map(threads.map((thread) => [thread.id, thread.activeOrderKey])),
      movedId: "a1",
    });
    const keys = new Map(assignments.map(({ id, orderKey }) => [id, orderKey]));
    const after = groupActiveThreadsByProject(
      sortActiveThreadsByOrderKey(
        threads.map((thread) => ({ ...thread, activeOrderKey: keys.get(thread.id) ?? null })),
      ),
      group,
    );

    expect(ids(before)).toEqual(["a1", "a2", "b1", "c1"]);
    expect(ids(after)).toEqual(["a2", "a1", "b1", "c1"]);
  });

  it("keeps project placement during an optimistic reorder", () => {
    expect(ids(groupActiveThreadsByProject(threads.toReversed(), group))).toEqual([
      "a2",
      "a1",
      "b1",
      "c1",
    ]);
  });

  it("honors saved project order and leads with unsaved projects", () => {
    expect(ids(groupActiveThreadsByProject(threads, group, ["C", "A"]))).toEqual([
      "b1",
      "c1",
      "a1",
      "a2",
    ]);
    expect(ids(groupActiveThreadsByProject(threads, group, ["C", "B", "A"]))).toEqual([
      "c1",
      "b1",
      "a1",
      "a2",
    ]);
  });

  it("leads with pinned projects in their pin order", () => {
    expect(ids(groupActiveThreadsByProject(threads, group, ["C", "A"], ["B"]))).toEqual([
      "b1",
      "c1",
      "a1",
      "a2",
    ]);
    expect(ids(groupActiveThreadsByProject(threads, group, [], ["C", "A"]))).toEqual([
      "c1",
      "a1",
      "a2",
      "b1",
    ]);
  });

  it("still promotes a project when a thread is created or reopened", () => {
    for (const fields of [
      { createdAt: "2026-10-01T10:04:00Z" },
      { unsettledAt: "2026-10-01T10:04:00Z" },
    ]) {
      const updated = threads.map((thread) =>
        thread.id === "c1" ? { ...thread, ...fields } : thread,
      );
      expect(ids(groupActiveThreadsByProject(sortActiveThreadsByOrderKey(updated), group))).toEqual(
        ["c1", "a1", "a2", "b1"],
      );
    }
  });
});
