import { iconNames, type IconName } from "lucide-react/dynamic";
export { PROJECT_ICON_COLORS, projectIconColorClassName } from "./projectIconColors";

const POPULAR_PROJECT_ICONS = [
  "folder-code",
  "code-2",
  "terminal",
  "globe-2",
  "server",
  "database",
  "bot",
  "sparkles",
  "smartphone",
  "monitor",
  "cloud-cog",
  "package",
  "book-open",
  "flask-conical",
  "shield-check",
  "rocket",
  "gamepad-2",
  "music",
  "image",
  "shopping-bag",
  "git-branch",
  "workflow",
  "wrench",
  "layers-3",
] as const satisfies ReadonlyArray<IconName>;

export const PROJECT_EMOJIS: ReadonlyArray<{ readonly emoji: string; readonly label: string }> = [
  { emoji: "💻", label: "Computer" },
  { emoji: "🛠️", label: "Tools" },
  { emoji: "🚀", label: "Rocket" },
  { emoji: "🤖", label: "Robot" },
  { emoji: "✨", label: "Sparkles" },
  { emoji: "⚡", label: "Lightning" },
  { emoji: "🌐", label: "Web" },
  { emoji: "📱", label: "Mobile" },
  { emoji: "🖥️", label: "Desktop" },
  { emoji: "⌨️", label: "Keyboard" },
  { emoji: "⚙️", label: "Gear" },
  { emoji: "🗄️", label: "Database" },
  { emoji: "☁️", label: "Cloud" },
  { emoji: "📦", label: "Package" },
  { emoji: "📚", label: "Books" },
  { emoji: "🧪", label: "Test tube" },
  { emoji: "🔒", label: "Lock" },
  { emoji: "🎮", label: "Game" },
  { emoji: "🎵", label: "Music" },
  { emoji: "🎬", label: "Movie" },
  { emoji: "🖼️", label: "Picture" },
  { emoji: "🛍️", label: "Shopping" },
  { emoji: "🔥", label: "Fire" },
  { emoji: "💡", label: "Idea" },
  { emoji: "🧩", label: "Puzzle" },
  { emoji: "📊", label: "Chart" },
  { emoji: "🧠", label: "Brain" },
  { emoji: "🦄", label: "Unicorn" },
  { emoji: "🐙", label: "Octopus" },
  { emoji: "🌱", label: "Seedling" },
];

export function filterProjectIconNames(query: string): ReadonlyArray<IconName> {
  const normalized = query.trim().toLowerCase().replaceAll(/\s+/g, "-");
  if (!normalized) return POPULAR_PROJECT_ICONS;
  return iconNames.filter((name) => name.includes(normalized)).slice(0, 60);
}

export type EmojiKeywords = Readonly<Record<string, ReadonlyArray<string>>>;

let emojiKeywords: Promise<EmojiKeywords> | null = null;

/** Loads the emoji keyword table as its own chunk the first time emoji search is needed. */
export function loadEmojiKeywords(): Promise<EmojiKeywords> {
  emojiKeywords ??= import("emojilib/dist/emoji-en-US.json").then(
    (module): EmojiKeywords => module.default,
    (error: unknown) => {
      emojiKeywords = null;
      throw error;
    },
  );
  return emojiKeywords;
}

function normalizeEmojiKeyword(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_]+/g, " ");
}

function emojiKeywordRank(keywords: ReadonlyArray<string>, query: string): number | null {
  const name = keywords[0] ?? "";
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (keywords.some((keyword) => keyword.startsWith(query))) return 2;
  if (keywords.some((keyword) => keyword.includes(query))) return 3;
  return null;
}

/** Ranks emoji by their name first, then by any keyword, keeping Unicode order within a rank. */
export function searchProjectEmojis(
  table: EmojiKeywords,
  query: string,
): ReadonlyArray<{ readonly emoji: string; readonly label: string }> {
  const normalized = normalizeEmojiKeyword(query);
  if (!normalized) return PROJECT_EMOJIS;
  const matches: Array<{ emoji: string; label: string; rank: number }> = [];
  for (const [emoji, rawKeywords] of Object.entries(table)) {
    const keywords = rawKeywords.map(normalizeEmojiKeyword);
    const rank = emojiKeywordRank(keywords, normalized);
    if (rank === null) continue;
    const name = keywords[0] ?? emoji;
    matches.push({ emoji, label: name.charAt(0).toUpperCase() + name.slice(1), rank });
  }
  return matches
    .toSorted((left, right) => left.rank - right.rank)
    .slice(0, 80)
    .map(({ emoji, label }) => ({ emoji, label }));
}

export function firstEmoji(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed);
  const segment = segments[Symbol.iterator]().next().value?.segment;
  const isFlag = /^\p{Regional_Indicator}{2}$/u.test(segment ?? "");
  const isKeycap = /^[#*0-9]\uFE0F?\u20E3$/u.test(segment ?? "");
  if (!segment || (!/\p{Extended_Pictographic}/u.test(segment) && !isFlag && !isKeycap)) {
    return null;
  }
  return segment;
}
