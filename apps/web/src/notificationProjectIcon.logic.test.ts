import { describe, expect, it, vi } from "vite-plus/test";

import { deriveProjectIdentity } from "./projectIdentity";
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
      "a named calendar override over the favicon",
      { title: "Acme Web", projectIcon: { kind: "lucide", name: "calendar", color: "red" } },
      FAVICON,
      { kind: "lucide", name: "calendar", color: "red" },
    ],
  ] as const)("uses %s", (_label, project, favicon, expected) => {
    expect(projectIconSource(project, favicon)).toEqual(expected);
  });

  it("takes the initials and colour the sidebar tile uses", () => {
    for (const title of ["Acme Web", "日本語 ツール", "🌿 garden"]) {
      const { monogram, color } = deriveProjectIdentity(title);
      expect(projectIconSource({ title }, null)).toEqual({
        kind: "monogram",
        text: monogram,
        color,
      });
    }
    expect(projectIconSource({ title: "日本語 ツール" }, null)).toMatchObject({ text: "日ツ" });
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
    expect(cache.get("env:p1", tile("AB"), false)).toBeNull();
    expect(draw).toHaveBeenCalledTimes(3);
  });

  it("forgets the project that notified longest ago", async () => {
    const cache = createProjectIconCache(async () => "png");
    for (let index = 0; index <= 64; index += 1) {
      await cache.warm(`env:p${index}`, tile("AW"), false);
      if (index === 63) await cache.warm("env:p0", tile("AW"), false);
    }
    expect(cache.get("env:p0", tile("AW"), false)).toBe("png");
    expect(cache.get("env:p1", tile("AW"), false)).toBeNull();
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
