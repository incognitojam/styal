import emojiKeywords from "emojilib/dist/emoji-en-US.json";
import { AlarmClockCheck, ArrowDown01, Layers3 } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";
import { lucideIconByName } from "./lib/lucideIconByName";
import {
  filterProjectIconNames,
  firstEmoji,
  PROJECT_EMOJIS,
  searchProjectEmojis,
} from "./projectIconOptions";

const emojiResults = (query: string) =>
  searchProjectEmojis(emojiKeywords, query).map((option) => option.emoji);

describe("projectIconOptions", () => {
  it("searches emoji by name and keyword", () => {
    expect(emojiResults("alien")[0]).toBe("👽");
    expect(emojiResults("ufo")).toEqual(expect.arrayContaining(["👽", "🛸"]));
    expect(emojiResults("Flying saucer")[0]).toBe("🛸");
    expect(emojiResults("flying_saucer")[0]).toBe("🛸");
    expect(searchProjectEmojis(emojiKeywords, "flying saucer")[0]?.label).toBe("Flying saucer");
    expect(emojiResults("zzzz-not-an-emoji")).toEqual([]);
  });

  it("shows the preset emoji for an empty search", () => {
    expect(searchProjectEmojis(emojiKeywords, "  ")).toBe(PROJECT_EMOJIS);
  });

  it("resolves every offered icon name, including saved legacy spellings", () => {
    for (const name of filterProjectIconNames("")) expect(lucideIconByName(name)).toBeDefined();
    expect(lucideIconByName("layers-3")).toBe(Layers3);
    expect(lucideIconByName("arrow-down-01")).toBe(ArrowDown01);
    expect(lucideIconByName("arrow-down-0-1")).toBe(ArrowDown01);
    expect(lucideIconByName("alarm-check")).toBe(AlarmClockCheck);
    expect(lucideIconByName("create-lucide-icon")).toBeUndefined();
  });

  it("extracts one complete emoji grapheme", () => {
    expect(firstEmoji("  👩🏽‍💻 hello")).toBe("👩🏽‍💻");
    expect(firstEmoji("🇺🇸 project")).toBe("🇺🇸");
    expect(firstEmoji("1️⃣ project")).toBe("1️⃣");
    expect(firstEmoji("plain text")).toBeNull();
  });
});
