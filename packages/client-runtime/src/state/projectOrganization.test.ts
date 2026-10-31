import { describe, expect, it } from "vite-plus/test";

import {
  nextProjectPinOrderKey,
  planProjectPinReorder,
  resolveProjectGroupPinOrder,
  sortPinnedProjectsFirst,
} from "./projectOrganization.ts";

const record = (fields: Partial<{ pinnedAt: string; pinOrderKey: string }> = {}) => ({
  pinnedAt: fields.pinnedAt ?? null,
  pinOrderKey: fields.pinOrderKey ?? null,
});

describe("resolveProjectGroupPinOrder", () => {
  it("takes the earliest pin and first slot across machines", () => {
    expect(
      resolveProjectGroupPinOrder([
        record({ pinnedAt: "2026-01-02T00:00:00.000Z", pinOrderKey: "t" }),
        record({ pinnedAt: "2026-01-01T00:00:00.000Z", pinOrderKey: "m" }),
        record(),
      ]),
    ).toEqual({ pinnedAt: "2026-01-01T00:00:00.000Z", pinOrderKey: "m" });
  });

  it("ignores the slot of an unpinned record", () => {
    expect(resolveProjectGroupPinOrder([record({ pinOrderKey: "a" })])).toEqual(record());
    expect(resolveProjectGroupPinOrder([])).toEqual(record());
  });
});

describe("sortPinnedProjectsFirst", () => {
  const project = (
    id: string,
    fields: Partial<{ pinnedAt: string; pinOrderKey: string }> = {},
  ) => ({
    id,
    ...record(fields),
  });

  it("moves pins to the top in slot order and keeps the rest in place", () => {
    const sorted = sortPinnedProjectsFirst([
      project("recent"),
      project("second", { pinnedAt: "2026-01-01T00:00:00.000Z", pinOrderKey: "t" }),
      project("older"),
      project("first", { pinnedAt: "2026-01-02T00:00:00.000Z", pinOrderKey: "m" }),
      project("keyless", { pinnedAt: "2026-01-04T00:00:00.000Z" }),
      project("keyless-first", { pinnedAt: "2026-01-03T00:00:00.000Z" }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual([
      "first",
      "second",
      "keyless-first",
      "keyless",
      "recent",
      "older",
    ]);
  });
});

describe("project pin slots", () => {
  it("puts a new pin after the last pinned slot", () => {
    const key = nextProjectPinOrderKey([
      record({ pinnedAt: "2026-01-01T00:00:00.000Z", pinOrderKey: "m" }),
      record({ pinOrderKey: "z" }),
    ]);
    expect(key).not.toBeNull();
    expect(key! > "m").toBe(true);
    expect(nextProjectPinOrderKey([])).not.toBeNull();
  });

  it("moves one pinned project with a single write", () => {
    const writes = planProjectPinReorder({
      orderedKeys: ["b", "a", "c"],
      pinOrderKeyByKey: new Map([
        ["a", "g"],
        ["b", "t"],
        ["c", "w"],
      ]),
      movedKey: "b",
    });
    expect(writes.map((write) => write.key)).toEqual(["b"]);
    expect(writes[0]!.pinOrderKey < "g").toBe(true);
  });
});
