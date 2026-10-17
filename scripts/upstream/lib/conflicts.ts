/**
 * Resolves cherry-pick conflict hunks that follow from known fork differences, using the
 * upstream base that `merge.conflictStyle=diff3` records in each hunk. A resolver only answers
 * when the fork's side of the hunk is fully explained; anything else stays for review.
 */

export interface ConflictHunk {
  /** The fork's text (HEAD). */
  readonly ours: string;
  /** Upstream's text before the picked change. */
  readonly base: string;
  /** Upstream's text after the picked change. */
  readonly theirs: string;
}

export type HunkResolution =
  | {
      readonly kind: "identity";
      readonly text: string;
      /** Replacements the fork applies to upstream's text in this hunk. */
      readonly replacements: ReadonlyArray<readonly [string, string]>;
    }
  | {
      readonly kind: "upstream-rename";
      readonly text: string;
      /** Renames upstream applies, carried onto the fork's side. */
      readonly replacements: ReadonlyArray<readonly [string, string]>;
    }
  | { readonly kind: "additions"; readonly text: string }
  | { readonly kind: "surrounding-additions"; readonly text: string }
  | { readonly kind: "superset"; readonly text: string }
  | { readonly kind: "unresolved" };

export interface ParsedConflictFile {
  /** Text between hunks, one more entry than `hunks`. */
  readonly segments: ReadonlyArray<string>;
  readonly hunks: ReadonlyArray<ConflictHunk>;
}

const OURS = /^<{7}(?: .*)?$/u;
const BASE = /^\|{7}(?: .*)?$/u;
const SPLIT = /^={7}$/u;
const THEIRS = /^>{7}(?: .*)?$/u;

/** Splits a diff3-style conflicted file into its plain segments and conflict hunks. */
export function parseConflictFile(content: string): ParsedConflictFile | null {
  // Each entry keeps its own newline, so segments and hunks concatenate back to the file.
  const lines = content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const bare = (line: string) => line.replace(/\r?\n$/u, "");
  const segments: Array<string> = [];
  const hunks: Array<ConflictHunk> = [];
  let segment = "";
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!OURS.test(bare(line))) {
      segment += line;
      index += 1;
      continue;
    }
    let ours = "";
    let base = "";
    let theirs = "";
    let section: "ours" | "base" | "theirs" = "ours";
    let closed = false;
    let sawBase = false;
    for (index += 1; index < lines.length; index += 1) {
      const current = lines[index]!;
      if (section === "ours" && BASE.test(bare(current))) {
        section = "base";
        sawBase = true;
      } else if (section !== "theirs" && SPLIT.test(bare(current))) section = "theirs";
      else if (section === "theirs" && THEIRS.test(bare(current))) {
        closed = true;
        break;
      } else if (section === "ours") ours += current;
      else if (section === "base") base += current;
      else theirs += current;
    }
    // A hunk without the base section was not written in diff3 style.
    if (!closed || !sawBase) return null;
    index += 1;
    segments.push(segment);
    segment = "";
    hunks.push({ ours, base, theirs });
  }
  segments.push(segment);
  return { segments, hunks };
}

/** Hunk sections keep their trailing newline so resolved text splices back unchanged. */
function joinLines(lines: ReadonlyArray<string>): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Rebuilds a file from its segments, putting conflict markers back for unresolved hunks. */
export function renderConflictFile(
  file: ParsedConflictFile,
  texts: ReadonlyArray<string | null>,
): string {
  return file.segments
    .map((segment, index) => {
      if (index >= file.hunks.length) return segment;
      const hunk = file.hunks[index]!;
      const text =
        texts[index] ??
        `<<<<<<< HEAD\n${hunk.ours}||||||| base\n${hunk.base}=======\n${hunk.theirs}>>>>>>> upstream\n`;
      return segment + text;
    })
    .join("");
}

const TOKEN = /[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/gu;

function tokens(text: string): ReadonlyArray<string> {
  return text.match(TOKEN) ?? [];
}

type Edit =
  | { readonly kind: "same"; readonly text: string }
  | {
      readonly kind: "replace";
      readonly from: string;
      readonly to: string;
      /** Index of the first `before` token the edit replaces or inserts at. */
      readonly at: number;
      readonly length: number;
    };

/** A token-level diff from `before` to `after`, grouping each changed run into one edit. */
function tokenEdits(before: string, after: string): ReadonlyArray<Edit> | null {
  const left = tokens(before);
  const right = tokens(after);
  // Hunks are small; a quadratic LCS keeps the edits minimal and readable.
  if (left.length * right.length > 4_000_000) return null;
  const table = Array.from({ length: left.length + 1 }, () =>
    Array.from({ length: right.length + 1 }, () => 0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        left[i] === right[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const edits: Array<Edit> = [];
  let from = "";
  let to = "";
  let start = 0;
  let i = 0;
  let j = 0;
  const flush = () => {
    if (from !== "" || to !== "") {
      edits.push({ kind: "replace", from, to, at: start, length: i - start });
    }
    from = "";
    to = "";
    start = i;
  };
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      flush();
      edits.push({ kind: "same", text: left[i]! });
      i += 1;
      j += 1;
      start = i;
    } else if (j < right.length && (i === left.length || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      to += right[j]!;
      j += 1;
    } else {
      from += left[i]!;
      i += 1;
    }
  }
  flush();
  return joinWhitespaceSeparatedEdits(edits);
}

/**
 * A multi-word rename such as `T3 Code` to `styal` diffs as two edits around the shared space;
 * this joins edits separated only by whitespace and trims the whitespace both sides share.
 */
function joinWhitespaceSeparatedEdits(edits: ReadonlyArray<Edit>): ReadonlyArray<Edit> {
  const joined: Array<Edit> = [];
  for (let index = 0; index < edits.length; index += 1) {
    let edit = edits[index]!;
    while (edit.kind === "replace") {
      const gap = edits[index + 1];
      const next = edits[index + 2];
      if (gap?.kind !== "same" || gap.text.trim() !== "" || next?.kind !== "replace") break;
      edit = {
        kind: "replace",
        from: edit.from + gap.text + next.from,
        to: edit.to + gap.text + next.to,
        at: edit.at,
        length: next.at + next.length - edit.at,
      };
      index += 2;
    }
    if (edit.kind === "replace") {
      const lead = Math.min(leadingSpace(edit.from), leadingSpace(edit.to));
      const trail = Math.min(trailingSpace(edit.from), trailingSpace(edit.to));
      edit = {
        ...edit,
        from: edit.from.slice(lead, edit.from.length - trail),
        to: edit.to.slice(lead, edit.to.length - trail),
      };
    }
    joined.push(edit);
  }
  return joined;
}

const leadingSpace = (text: string) => text.length - text.trimStart().length;
const trailingSpace = (text: string) => text.length - text.trimEnd().length;

/** Whether two edits of the same text touch any of the same tokens, or insert at one place. */
function editsOverlap(left: ReadonlyArray<Edit>, right: ReadonlyArray<Edit>): boolean {
  const spans = (edits: ReadonlyArray<Edit>) =>
    edits.flatMap((edit) => (edit.kind === "replace" ? [[edit.at, edit.length] as const] : []));
  for (const [leftAt, leftLength] of spans(left)) {
    for (const [rightAt, rightLength] of spans(right)) {
      const leftEnd = leftAt + Math.max(leftLength, 1);
      const rightEnd = rightAt + Math.max(rightLength, 1);
      if (leftAt < rightEnd && rightAt < leftEnd) return true;
    }
  }
  return false;
}

/** True when a replacement only renames upstream's product identity to the fork's. */
export function isIdentityReplacement(from: string, to: string): boolean {
  return from.trim() !== "" && /styal/iu.test(to) && !/styal/iu.test(from);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Applies replacements where each source appears as whole tokens. */
export function applyReplacements(
  text: string,
  replacements: ReadonlyArray<readonly [string, string]>,
): string {
  let output = text;
  for (const [from, to] of replacements) {
    const start = /^[A-Za-z0-9_]/u.test(from) ? "(?<![A-Za-z0-9_])" : "";
    const end = /[A-Za-z0-9_]$/u.test(from) ? "(?![A-Za-z0-9_])" : "";
    output = output.replace(new RegExp(`${start}${escapeRegExp(from)}${end}`, "gu"), () => to);
  }
  return output;
}

/**
 * The fork's side is upstream's base with only product-identity renames, such as `T3 Code` to
 * `styal`. Upstream's new text takes the same renames.
 */
export function resolveIdentityHunk(hunk: ConflictHunk): HunkResolution {
  if (hunk.ours === hunk.base) return { kind: "unresolved" };
  const edits = tokenEdits(hunk.base, hunk.ours);
  if (edits === null) return { kind: "unresolved" };
  const replacements: Array<readonly [string, string]> = [];
  for (const edit of edits) {
    if (edit.kind === "same") continue;
    if (!isIdentityReplacement(edit.from, edit.to)) return { kind: "unresolved" };
    if (!replacements.some(([from, to]) => from === edit.from && to === edit.to)) {
      replacements.push([edit.from, edit.to]);
    }
  }
  if (replacements.length === 0) return { kind: "unresolved" };
  // The renames must reproduce the fork's side exactly before they are trusted on upstream's.
  if (applyReplacements(hunk.base, replacements) !== hunk.ours) return { kind: "unresolved" };
  // Upstream rewrote a name the fork renamed, as when it shortened its own branch prefix; that
  // is a decision about the fork's name, not a rename to carry over.
  const upstreamEdits = tokenEdits(hunk.base, hunk.theirs);
  if (upstreamEdits === null || editsOverlap(edits, upstreamEdits)) return { kind: "unresolved" };
  return {
    kind: "identity",
    text: renameOutsideModuleSpecifiers(hunk.theirs, replacements),
    replacements,
  };
}

const MODULE_SPECIFIER_LINE = /\bfrom\s*["']|\bimport\s*\(|\brequire\s*\(|^\s*import\s*["']/u;

/** Renames text line by line, leaving import and require lines alone: a path names a file. */
function renameOutsideModuleSpecifiers(
  text: string,
  replacements: ReadonlyArray<readonly [string, string]>,
): string {
  return text
    .split("\n")
    .map((line) =>
      MODULE_SPECIFIER_LINE.test(line) ? line : applyReplacements(line, replacements),
    )
    .join("\n");
}

/** A rename source or target: one identifier or module path, without spaces or quotes. */
const RENAMEABLE = /^[A-Za-z_$][\w$]*(?:[./@-][\w$]+)*\/?$|^[\w$@./-]*\/[\w$@./-]*$/u;

/**
 * Identifiers a refactor renames carry their shape: camelCase, PascalCase, a `_` or `$`, or a
 * module path. Plain lowercase words and literals such as `false` or `info` are values, and a
 * changed value is an edit, not a rename to apply elsewhere.
 */
function isRenamedIdentifier(from: string, to: string): boolean {
  const shaped = (word: string) =>
    /[A-Z_$/]/u.test(word) && !/^(true|false|null|undefined)$/u.test(word);
  return RENAMEABLE.test(from) && RENAMEABLE.test(to) && shaped(from) && shaped(to);
}

/**
 * Upstream's side only renames identifiers or module paths in the base, as a mechanical refactor
 * does, while the fork changed other parts of the hunk. The fork's side takes the same renames,
 * including in lines only the fork has.
 */
export function resolveUpstreamRenameHunk(hunk: ConflictHunk): HunkResolution {
  if (hunk.theirs === hunk.base || hunk.ours === hunk.base) return { kind: "unresolved" };
  const upstreamEdits = tokenEdits(hunk.base, hunk.theirs);
  const forkEdits = tokenEdits(hunk.base, hunk.ours);
  if (upstreamEdits === null || forkEdits === null) return { kind: "unresolved" };
  const replacements: Array<readonly [string, string]> = [];
  for (const edit of upstreamEdits) {
    if (edit.kind === "same") continue;
    if (!isRenamedIdentifier(edit.from, edit.to)) return { kind: "unresolved" };
    const existing = replacements.find(([from]) => from === edit.from);
    if (existing && existing[1] !== edit.to) return { kind: "unresolved" };
    if (!existing) replacements.push([edit.from, edit.to]);
  }
  if (replacements.length === 0) return { kind: "unresolved" };
  if (applyReplacements(hunk.base, replacements) !== hunk.theirs) return { kind: "unresolved" };
  if (editsOverlap(upstreamEdits, forkEdits)) return { kind: "unresolved" };
  return {
    kind: "upstream-rename",
    text: applyReplacements(hunk.ours, replacements),
    replacements,
  };
}

function splitLines(text: string): ReadonlyArray<string> {
  return text === "" ? [] : text.replace(/\n$/u, "").split("\n");
}

/** Lines `side` inserts around `base`, keyed by the base line they precede, or null on edits. */
function insertionsAround(
  base: ReadonlyArray<string>,
  side: ReadonlyArray<string>,
): Map<number, ReadonlyArray<string>> | null {
  const insertions = new Map<number, Array<string>>();
  let at = 0;
  for (const line of side) {
    if (at < base.length && line === base[at]) {
      at += 1;
      continue;
    }
    const list = insertions.get(at) ?? [];
    list.push(line);
    insertions.set(at, list);
  }
  return at === base.length ? insertions : null;
}

/**
 * Both sides only add lines around upstream's unchanged base, as when each adds an import,
 * export, or list entry at the same place. The result keeps the fork's additions, then
 * upstream's, at each position.
 */
export function resolveAdditionsHunk(hunk: ConflictHunk): HunkResolution {
  const base = splitLines(hunk.base);
  const ours = insertionsAround(base, splitLines(hunk.ours));
  const theirs = insertionsAround(base, splitLines(hunk.theirs));
  if (ours === null || theirs === null || ours.size === 0 || theirs.size === 0) {
    return { kind: "unresolved" };
  }
  const oursAdded = [...ours.values()].flat();
  const theirsAdded = [...theirs.values()].flat();
  if (bracketDelta(oursAdded) !== 0 || bracketDelta(theirsAdded) !== 0)
    return { kind: "unresolved" };
  // An added line equal to a base line could belong on either side of it.
  if ([...oursAdded, ...theirsAdded].some((line) => base.includes(line))) {
    return { kind: "unresolved" };
  }
  // One side's additions already contain the other's, as when upstream lands the fork's earlier
  // import of the same lines with more around them.
  if (isSubsequence(oursAdded, theirsAdded)) return { kind: "superset", text: hunk.theirs };
  if (isSubsequence(theirsAdded, oursAdded)) return { kind: "superset", text: hunk.ours };

  const merged: Array<string> = [];
  for (let at = 0; at <= base.length; at += 1) {
    const added = ours.get(at) ?? [];
    const upstreamAdded = theirs.get(at) ?? [];
    merged.push(...added);
    // Identical blocks are one change made twice; anything else keeps every line of both.
    if (upstreamAdded.join("\n") !== added.join("\n")) merged.push(...upstreamAdded);
    if (at < base.length) merged.push(base[at]!);
  }
  return { kind: "additions", text: joinLines(merged) };
}

/**
 * Open minus closed brackets in code lines, ignoring string contents and line comments. Two
 * added blocks only combine when each is balanced; a block that opens a function whose closing
 * brace lies outside the hunk is half of a change.
 */
export function bracketDelta(lines: ReadonlyArray<string>): number {
  let delta = 0;
  for (const line of lines) {
    const code = line
      .replace(/\/\/.*$/u, "")
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/gu, "");
    for (const character of code) {
      if (character === "{" || character === "(" || character === "[") delta += 1;
      else if (character === "}" || character === ")" || character === "]") delta -= 1;
    }
  }
  return delta;
}

function isSubsequence(needle: ReadonlyArray<string>, haystack: ReadonlyArray<string>): boolean {
  let at = 0;
  for (const line of haystack) if (at < needle.length && line === needle[at]) at += 1;
  return at === needle.length;
}

/** Files whose lines cannot be combined by position, such as patches and JSON with commas. */
const NO_LINE_UNION = /\.(patch|json|lock|snap)$|(^|\/)pnpm-lock\.yaml$/u;

/** Where `inner` occurs as a contiguous run of lines in `outer`, or -1. */
function indexOfLines(outer: ReadonlyArray<string>, inner: ReadonlyArray<string>): number {
  if (inner.length === 0 || inner.length > outer.length) return -1;
  for (let at = 0; at + inner.length <= outer.length; at += 1) {
    if (inner.every((line, offset) => outer[at + offset] === line)) return at;
  }
  return -1;
}

/**
 * One side keeps upstream's base intact and only adds lines before or after it, while the other
 * side edits the base: the edited base goes between the added lines.
 */
export function resolveSurroundingAdditionsHunk(hunk: ConflictHunk): HunkResolution {
  const base = splitLines(hunk.base);
  if (base.length === 0) return { kind: "unresolved" };
  for (const [wrapping, edited] of [
    [hunk.ours, hunk.theirs],
    [hunk.theirs, hunk.ours],
  ] as const) {
    const outer = splitLines(wrapping);
    const at = indexOfLines(outer, base);
    if (
      at === -1 ||
      outer.length === base.length ||
      indexOfLines(outer.slice(at + 1), base) !== -1
    ) {
      continue;
    }
    const added = [...outer.slice(0, at), ...outer.slice(at + base.length)];
    if (bracketDelta(added) !== 0) continue;
    const merged = [...outer.slice(0, at), ...splitLines(edited), ...outer.slice(at + base.length)];
    return { kind: "surrounding-additions", text: joinLines(merged) };
  }
  return { kind: "unresolved" };
}

export function resolveHunk(hunk: ConflictHunk, path = ""): HunkResolution {
  const identity = resolveIdentityHunk(hunk);
  if (identity.kind !== "unresolved") return identity;
  const rename = resolveUpstreamRenameHunk(hunk);
  if (rename.kind !== "unresolved") return rename;
  if (NO_LINE_UNION.test(path)) return { kind: "unresolved" };
  const additions = resolveAdditionsHunk(hunk);
  if (additions.kind !== "unresolved") return additions;
  return resolveSurroundingAdditionsHunk(hunk);
}
