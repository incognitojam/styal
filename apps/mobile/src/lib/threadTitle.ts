export function deriveThreadTitleFromPrompt(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "New thread";

  const compact = trimmed.replace(/\s+/g, " ");
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
}
