import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";

export interface TurnDiffFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

/** Reads Git's NUL-delimited numstat output without decoding display paths. */
export function parseTurnDiffFilesFromNumstat(numstat: string): ReadonlyArray<TurnDiffFileSummary> {
  const records = numstat.split("\0");
  const files: TurnDiffFileSummary[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!counts) continue;

    let path = record.slice(counts[0].length);
    if (path.length === 0) {
      // Renames and copies use two more records: the source and destination.
      path = records[index + 2] ?? "";
      index += 2;
    }
    if (path.length === 0) continue;

    files.push({
      path,
      additions: counts[1] === "-" ? 0 : Number(counts[1]),
      deletions: counts[2] === "-" ? 0 : Number(counts[2]),
    });
  }

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

/**
 * Reads the changed file paths from a unified patch, such as a pull request's diff, using only
 * each file's header lines. A rename or copy reports its destination and a deletion its old path.
 * Expects Git's `a/` and `b/` prefixes; quoted paths are unescaped, including octal UTF-8 bytes.
 */
export function parseUnifiedDiffPaths(diff: string): ReadonlyArray<string> {
  const paths: string[] = [];
  let header: FileHeader | null = null;
  const finish = () => {
    const path = header === null ? null : headerPath(header);
    if (path !== null && path.length > 0) paths.push(path);
  };

  for (const rawLine of diff.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("diff --git ")) {
      finish();
      header = { gitLine: line.slice("diff --git ".length), inHunks: false };
      continue;
    }
    // Hunk lines can start with "--- " or "+++ ", so header lines stop at the first hunk.
    if (header === null || header.inHunks) continue;
    if (line.startsWith("@@")) header.inHunks = true;
    else if (line.startsWith("+++ ")) header.newPath = patchLinePath(line.slice(4));
    else if (line.startsWith("--- ")) header.oldPath = patchLinePath(line.slice(4));
    else if (line.startsWith("rename to ")) header.target = unquoteGitPatchPath(line.slice(10));
    else if (line.startsWith("copy to ")) header.target = unquoteGitPatchPath(line.slice(8));
  }
  finish();

  return [...new Set(paths)].toSorted((left, right) => left.localeCompare(right));
}

interface FileHeader {
  readonly gitLine: string;
  inHunks: boolean;
  newPath?: string | null;
  oldPath?: string | null;
  target?: string;
}

function headerPath(header: FileHeader): string | null {
  if (header.target !== undefined) return header.target;
  if (header.newPath) return header.newPath;
  if (header.oldPath) return header.oldPath;
  return gitLinePath(header.gitLine);
}

/** A `---`/`+++` path; null for /dev/null. Git ends the line with a tab when the path has a space. */
function patchLinePath(value: string): string | null {
  const raw = value.endsWith("\t") ? value.slice(0, -1) : value;
  if (raw === "/dev/null") return null;
  return stripPrefix(unquoteGitPatchPath(raw));
}

/**
 * The path from `diff --git a/<path> b/<path>`, used when a file has no `---`/`+++` lines, such as
 * a binary or empty file. Without a rename or copy both sides name the same path.
 */
function gitLinePath(value: string): string | null {
  if (value.startsWith('"')) {
    const end = quotedEnd(value);
    const rest = value.slice(end + 1).trimStart();
    return rest.length > 0 ? stripPrefix(unquoteGitPatchPath(rest)) : null;
  }
  if ((value.length - 1) % 2 !== 0) return null;
  const half = (value.length - 1) / 2;
  const left = value.slice(0, half);
  const right = value.slice(half + 1);
  return stripPrefix(left) === stripPrefix(right) ? stripPrefix(right) : null;
}

function stripPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function quotedEnd(value: string): number {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === "\\") index += 1;
    else if (value[index] === '"') return index;
  }
  return value.length - 1;
}
