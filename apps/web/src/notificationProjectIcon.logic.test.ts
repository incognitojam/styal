import { describe, expect, it, vi } from "vite-plus/test";

import {
  createProjectIconCache,
  projectIconSource,
  type ProjectIconSource,
} from "./notificationProjectIcon.logic";

const FAVICON = "data:image/png;base64,iVBORw0KGgo=";

describe("projectIconSource", () => {
  it.each([
    [
      "the cached favicon, with the initials tile behind it",
      { title: "Acme Web" },
      FAVICON,
      {
        kind: "image",
        dataUrl: FAVICON,
        fallback: { kind: "monogram", text: "AW", color: expect.any(String) },
      },
    ],
    [
      "the initials tile without a favicon",
      { title: "Acme Web" },
      null,
      { kind: "monogram", text: "AW", color: expect.any(String) },
    ],
    [
      "the initials tile for a URL that would need a fetch",
      { title: "Acme Web" },
      "https://example.com/favicon.png",
      { kind: "monogram", text: "AW", color: expect.any(String) },
    ],
    [
      "a monogram override over the favicon",
      { title: "Acme Web", projectIcon: { kind: "monogram", text: "XY", color: "teal" } },
      FAVICON,
      { kind: "monogram", text: "XY", color: "teal" },
    ],
    [
      "an emoji override",
      { title: "Acme Web", projectIcon: { kind: "emoji", emoji: "🌿" } },
      FAVICON,
      { kind: "emoji", emoji: "🌿" },
    ],
    [
      "the initials tile for a lucide override",
      { title: "Acme Web", projectIcon: { kind: "lucide", name: "rocket", color: "red" } },
      FAVICON,
      { kind: "monogram", text: "AW", color: expect.any(String) },
    ],
  ] as const)("uses %s", (_label, project, favicon, expected) => {
    expect(projectIconSource(project, favicon)).toEqual(expected);
  });

  it("takes the initials and colour from the same rule as the sidebar tile", () => {
    const tile = (title: string) => projectIconSource({ title }, null);
    expect(tile("Acme Web")).toEqual(tile("Acme Web"));
    expect(tile("日本語 ツール")).toMatchObject({ kind: "monogram", text: "日ツ" });
  });
});

describe("createProjectIconCache", () => {
  const tile = (text: string): ProjectIconSource => ({ kind: "monogram", text, color: "blue" });

  it("draws once per project and appearance, and again when the source changes", async () => {
    const draw = vi.fn(async (source: ProjectIconSource, dark: boolean) =>
      source.kind === "monogram" ? `png:${source.text}:${dark}` : "png:image",
    );
    const cache = createProjectIconCache(draw);

    expect(cache.get("env:p1", tile("AW"), false)).toBeNull();
    await cache.warm("env:p1", tile("AW"), false);
    expect(cache.get("env:p1", tile("AW"), false)).toBe("png:AW:false");
    await cache.warm("env:p1", tile("AW"), false);
    expect(draw).toHaveBeenCalledTimes(1);

    await cache.warm("env:p1", tile("AB"), false);
    expect(cache.get("env:p1", tile("AB"), false)).toBe("png:AB:false");
    await cache.warm("env:p1", tile("AB"), true);
    expect(cache.get("env:p1", tile("AB"), true)).toBe("png:AB:true");
    expect(draw).toHaveBeenCalledTimes(3);
  });

  it("keeps the newest source when an older drawing finishes later", async () => {
    let finishFirst = (_icon: string) => {};
    const draw = vi.fn((source: ProjectIconSource) =>
      source.kind === "monogram" && source.text === "AW"
        ? new Promise<string>((resolve) => (finishFirst = resolve))
        : Promise.resolve("png:new"),
    );
    const cache = createProjectIconCache(draw);
    const first = cache.warm("env:p1", tile("AW"), false);
    await cache.warm("env:p1", tile("AB"), false);
    finishFirst("png:old");
    await first;
    expect(cache.get("env:p1", tile("AB"), false)).toBe("png:new");
    expect(cache.get("env:p1", tile("AW"), false)).toBeNull();
  });

  it("stays without an icon, and does not retry, when drawing fails", async () => {
    const draw = vi.fn(async () => {
      throw new Error("canvas unavailable");
    });
    const cache = createProjectIconCache(draw);
    await cache.warm("env:p1", tile("AW"), false);
    expect(cache.get("env:p1", tile("AW"), false)).toBeNull();
    await cache.warm("env:p1", tile("AW"), false);
    expect(draw).toHaveBeenCalledTimes(1);
  });
});
