/**
 * Identifier renames an upstream commit makes, read from its diff, so fork code that still uses
 * the old names can take the new ones. Only line pairs that differ by identifiers alone count,
 * and a name renamed two different ways is dropped.
 */

const TOKEN = /[A-Za-z_$][\w$]*|\w+|\s+|[^\w\s$]/gu;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

function tokens(text: string): ReadonlyArray<string> {
  return text.match(TOKEN) ?? [];
}

/**
 * Renames in a `git diff -U0` patch. Within each hunk, removed and added lines pair up in order
 * when there are as many of each; a pair contributes only when its tokens differ solely in
 * identifiers.
 */
export function deriveIdentifierRenames(patch: string): ReadonlyMap<string, string> {
  const renames = new Map<string, string>();
  const inconsistent = new Set<string>();
  let removed: Array<string> = [];
  let added: Array<string> = [];
  const flush = () => {
    if (removed.length > 0 && removed.length === added.length) {
      removed.forEach((line, index) => {
        const before = tokens(line);
        const after = tokens(added[index]!);
        if (before.length !== after.length) return;
        const pairs: Array<readonly [string, string]> = [];
        for (let position = 0; position < before.length; position += 1) {
          if (before[position] === after[position]) continue;
          if (!IDENTIFIER.test(before[position]!) || !IDENTIFIER.test(after[position]!)) return;
          pairs.push([before[position]!, after[position]!]);
        }
        for (const [from, to] of pairs) {
          const existing = renames.get(from);
          if (existing !== undefined && existing !== to) inconsistent.add(from);
          else renames.set(from, to);
        }
      });
    }
    removed = [];
    added = [];
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff ") || line.startsWith("@@")) {
      flush();
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      if (added.length > 0) flush();
      removed.push(line.slice(1));
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added.push(line.slice(1));
    }
  }
  flush();
  for (const name of inconsistent) renames.delete(name);
  return renames;
}

/** Replaces whole identifiers that have a rename. */
export function applyIdentifierRenames(text: string, renames: ReadonlyMap<string, string>): string {
  if (renames.size === 0) return text;
  return tokens(text)
    .map((token) => renames.get(token) ?? token)
    .join("");
}
