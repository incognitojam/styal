#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - Local, synchronous maintainer CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { readLagHistory, replayIntake, type LagHistory } from "./lag-report.ts";

type Run = (command: string, args: string[]) => string;

const DAY = 86_400_000;

/** Vendored references and the lockfile follow dependency versions, not fork changes. */
export const EXCLUDED_PATHS = [":(exclude,glob).repos/**", ":(exclude)pnpm-lock.yaml"];

export interface FileDifference {
  /** A: fork-only file, M: changed upstream file, D: upstream file the fork removes, R: renamed. */
  status: "A" | "M" | "D" | "R";
  path: string;
  /** Upstream path of a renamed file. */
  from: string | null;
  insertions: number;
  deletions: number;
}

export interface Divergence {
  fork: string;
  upstream: string;
  files: FileDifference[];
}

export interface DivergenceTotals {
  changedFiles: number;
  changedInsertions: number;
  changedDeletions: number;
  removedFiles: number;
  removedLines: number;
  forkOnlyFiles: number;
  forkOnlyLines: number;
}

/** Parses `git diff -z --name-status` and `git diff -z --numstat` output for the same diff. */
export function parseDiff(nameStatus: string, numstat: string): FileDifference[] {
  const statusFields = nameStatus.split("\0");
  const numstatFields = numstat.split("\0");
  const files: FileDifference[] = [];
  let s = 0;
  let n = 0;
  while (s < statusFields.length && statusFields[s]) {
    const code = statusFields[s++]![0]!;
    const renamed = code === "R" || code === "C";
    const from = renamed ? statusFields[s++]! : null;
    const path = statusFields[s++]!;
    const [insertions = "0", deletions = "0", inlinePath = ""] = numstatFields[n++]!.split("\t");
    if (inlinePath === "") n += 2;
    files.push({
      status: code === "C" ? "A" : renamed ? "R" : code === "A" || code === "D" ? code : "M",
      path,
      from,
      // Binary files report "-" and count as one changed file with no lines.
      insertions: insertions === "-" ? 0 : Number(insertions),
      deletions: deletions === "-" ? 0 : Number(deletions),
    });
  }
  return files;
}

export function readDivergence(run: Run, upstream: string, fork: string): Divergence {
  const diff = (format: string) =>
    run("git", [
      "-c",
      "diff.renameLimit=50000",
      "diff",
      "-z",
      "-M",
      "--no-ext-diff",
      format,
      upstream,
      fork,
      "--",
      ".",
      ...EXCLUDED_PATHS,
    ]);
  return { fork, upstream, files: parseDiff(diff("--name-status"), diff("--numstat")) };
}

export function totalDivergence(files: readonly FileDifference[]): DivergenceTotals {
  const totals: DivergenceTotals = {
    changedFiles: 0,
    changedInsertions: 0,
    changedDeletions: 0,
    removedFiles: 0,
    removedLines: 0,
    forkOnlyFiles: 0,
    forkOnlyLines: 0,
  };
  for (const file of files) {
    if (file.status === "A") {
      totals.forkOnlyFiles++;
      totals.forkOnlyLines += file.insertions;
    } else if (file.status === "D") {
      totals.removedFiles++;
      totals.removedLines += file.deletions;
    } else {
      totals.changedFiles++;
      totals.changedInsertions += file.insertions;
      totals.changedDeletions += file.deletions;
    }
  }
  return totals;
}

/** Counts upstream's tracked files and text lines outside the excluded paths. */
export function readUpstreamSize(run: Run, upstream: string): { files: number; lines: number } {
  const files = run("git", ["ls-tree", "-r", "-z", "--name-only", upstream, "--", "."])
    .split("\0")
    .filter((path) => path && !path.startsWith(".repos/") && path !== "pnpm-lock.yaml").length;
  const lines = run("git", ["grep", "-I", "-c", "", upstream, "--", ".", ...EXCLUDED_PATHS])
    .split("\n")
    .filter(Boolean)
    .reduce((total, line) => total + Number(line.slice(line.lastIndexOf(":") + 1)), 0);
  return { files, lines };
}

/** Returns the upstream commit at the in-order tip for each fork first-parent commit. */
export function inOrderTips(
  history: LagHistory,
): Array<{ fork: string; time: number; upstream: string }> {
  return replayIntake(history).steps.map((step, index) => ({
    fork: history.fork[index]!.sha,
    time: step.time,
    upstream: step.tip === 0 ? history.base.sha : history.upstream[step.tip - 1]!.sha,
  }));
}

/** Groups a path into the area shown in breakdowns: `apps/web`, `packages/contracts`, `docs`. */
export function areaOf(path: string): string {
  const [first, second] = path.split("/");
  if (second === undefined) return "(root)";
  return first === "apps" || first === "packages" || first === "infra"
    ? `${first}/${second}`
    : first!;
}

const formatNumber = (value: number) => value.toLocaleString("en-US");
const formatSigned = (value: number) =>
  value === 0 ? "0" : `${value > 0 ? "+" : "−"}${formatNumber(Math.abs(value))}`;
const formatPercent = (part: number, whole: number) =>
  whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(1)}%`;
const formatDay = (time: number) =>
  new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function areaTable(files: readonly FileDifference[], limit = 12): string[] {
  const areas = new Map<
    string,
    { changed: number; lines: number; forkOnly: number; forkOnlyLines: number }
  >();
  for (const file of files) {
    const area = areas.get(areaOf(file.path)) ?? {
      changed: 0,
      lines: 0,
      forkOnly: 0,
      forkOnlyLines: 0,
    };
    if (file.status === "A") {
      area.forkOnly++;
      area.forkOnlyLines += file.insertions;
    } else {
      area.changed++;
      area.lines += file.insertions + file.deletions;
    }
    areas.set(areaOf(file.path), area);
  }
  const rows = [...areas].sort(
    ([, a], [, b]) => b.lines - a.lines || b.forkOnlyLines - a.forkOnlyLines,
  );
  return [
    "| Area | Upstream files changed | Lines changed in them | Fork-only files | Fork-only lines |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...rows
      .slice(0, limit)
      .map(
        ([area, row]) =>
          `| \`${area}\` | ${formatNumber(row.changed)} | ${formatNumber(row.lines)} | ${formatNumber(row.forkOnly)} | ${formatNumber(row.forkOnlyLines)} |`,
      ),
    ...(rows.length > limit ? [`| ${rows.length - limit} more areas | | | | |`] : []),
  ];
}

export function renderSnapshot(
  divergence: Divergence,
  size: { files: number; lines: number },
  links: { upstream: (sha: string) => string },
): string[] {
  const totals = totalDivergence(divergence.files);
  const upstreamTouched = totals.changedFiles + totals.removedFiles;
  const upstreamLines = totals.changedInsertions + totals.changedDeletions + totals.removedLines;
  return [
    `Compared with upstream at the in-order tip ${links.upstream(divergence.upstream)}, excluding \`.repos/\` and \`pnpm-lock.yaml\`.`,
    "",
    "| Measure | Files | Lines |",
    "| --- | ---: | ---: |",
    `| **Upstream files the fork changes** | **${formatNumber(totals.changedFiles)}** | **+${formatNumber(totals.changedInsertions)} −${formatNumber(totals.changedDeletions)}** |`,
    `| Upstream files the fork removes | ${formatNumber(totals.removedFiles)} | −${formatNumber(totals.removedLines)} |`,
    `| Share of upstream that differs | ${formatPercent(upstreamTouched, size.files)} of ${formatNumber(size.files)} | ${formatPercent(upstreamLines, size.lines)} of ${formatNumber(size.lines)} |`,
    `| Fork-only files | ${formatNumber(totals.forkOnlyFiles)} | +${formatNumber(totals.forkOnlyLines)} |`,
    "",
  ];
}

export function renderHistory(
  current: Divergence,
  size: { files: number; lines: number },
  daily: Array<{ day: number; totals: DivergenceTotals }>,
  links: { upstream: (sha: string) => string },
): string {
  const labels = daily.map((row, index) => {
    const date = new Date(row.day);
    const month = date.getUTCMonth() !== new Date(daily[index - 1]?.day ?? NaN).getUTCMonth();
    return month ? `${date.getUTCMonth() + 1}/${date.getUTCDate()}` : String(date.getUTCDate());
  });
  const chart = (
    title: string,
    yAxis: string,
    series: Array<{ color: string; values: number[] }>,
  ) => {
    const max = Math.max(1, ...series.flatMap((entry) => entry.values));
    const step = 10 ** Math.floor(Math.log10(max));
    const config = {
      xyChart: { width: 900, height: 360 },
      themeVariables: {
        xyChart: { plotColorPalette: series.map((entry) => entry.color).join(", ") },
      },
    };
    return [
      "```mermaid",
      `%%{init: ${JSON.stringify(config)}}%%`,
      "xychart-beta",
      `  title "${title}"`,
      `  x-axis [${labels.map((label) => `"${label}"`).join(", ")}]`,
      `  y-axis "${yAxis}" 0 --> ${Math.ceil(max / step) * step}`,
      ...series.map((entry) => `  line [${entry.values.join(", ")}]`),
      "```",
    ].join("\n");
  };
  return [
    "## Upstream divergence",
    "",
    ...renderSnapshot(current, size, links),
    "### Divergence over time",
    "",
    "Each day compares the last fork `main` commit with upstream at that commit's in-order tip. In-order intake leaves the lines flat unless it drops fork changes; fork pull requests and early imports raise them.",
    "",
    "🟧 Lines changed in upstream files · 🟦 Lines in fork-only files",
    "",
    chart("Fork divergence from the in-order tip", "Lines", [
      {
        color: "#eb6834",
        values: daily.map(
          (row) =>
            row.totals.changedInsertions + row.totals.changedDeletions + row.totals.removedLines,
        ),
      },
      { color: "#2a78d6", values: daily.map((row) => row.totals.forkOnlyLines) },
    ]),
    "",
    "🟧 Upstream files the fork changes or removes · 🟦 Fork-only files",
    "",
    chart("Files differing from the in-order tip", "Files", [
      {
        color: "#eb6834",
        values: daily.map((row) => row.totals.changedFiles + row.totals.removedFiles),
      },
      { color: "#2a78d6", values: daily.map((row) => row.totals.forkOnlyFiles) },
    ]),
    "",
    "<details><summary>Divergence by area</summary>",
    "",
    ...areaTable(current.files, 30),
    "",
    "</details>",
    "",
    "<details><summary>Daily values</summary>",
    "",
    "| End of day (UTC) | Upstream files changed | Lines changed in them | Upstream files removed | Fork-only files | Fork-only lines |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...daily.map(
      ({ day, totals }) =>
        `| ${formatDay(day)} | ${formatNumber(totals.changedFiles)} | +${formatNumber(totals.changedInsertions)} −${formatNumber(totals.changedDeletions)} | ${formatNumber(totals.removedFiles)} | ${formatNumber(totals.forkOnlyFiles)} | ${formatNumber(totals.forkOnlyLines)} |`,
    ),
    "",
    "</details>",
    "",
  ].join("\n");
}

/** Per-file difference from upstream, in changed lines, keyed by fork path. */
const fileWeights = (divergence: Divergence) =>
  new Map(divergence.files.map((file) => [file.path, file]));

export function renderComparison(
  before: Divergence,
  after: Divergence,
  labels: { before: string; after: string; heading: string; marker?: string },
  links: { upstream: (sha: string) => string; fork: (path: string) => string },
  /** Paths in upstream's tree at the before tip, to recognise files upstream has since deleted. */
  beforeUpstreamPaths: ReadonlySet<string>,
  limit = 25,
): string {
  const a = totalDivergence(before.files);
  const b = totalDivergence(after.files);
  const row = (measure: string, from: number, to: number) =>
    `| ${measure} | ${formatNumber(from)} | ${formatNumber(to)} | ${to === from ? "0" : `**${formatSigned(to - from)}**`} |`;

  const beforeFiles = fileWeights(before);
  const afterFiles = fileWeights(after);
  const weight = (file: FileDifference | undefined) =>
    file ? file.insertions + file.deletions : 0;
  const shared = (file: FileDifference | undefined) => file !== undefined && file.status !== "A";
  const starts: FileDifference[] = [];
  const returns: FileDifference[] = [];
  const kept: FileDifference[] = [];
  const shifts: Array<{ path: string; change: number; total: number }> = [];
  for (const [path, file] of afterFiles) {
    const previous = beforeFiles.get(path);
    // Upstream deleted a file the fork still has, so it now counts as fork-only.
    if (file.status === "A" && previous?.status !== "A" && beforeUpstreamPaths.has(path))
      kept.push(file);
    else if (shared(file) && !shared(previous)) starts.push(file);
    else if (shared(file) && weight(file) !== weight(previous))
      shifts.push({ path, change: weight(file) - weight(previous), total: weight(file) });
  }
  for (const [path, file] of beforeFiles) {
    if (shared(file) && afterFiles.get(path) === undefined) returns.push(file);
  }
  shifts.sort((x, y) => Math.abs(y.change) - Math.abs(x.change));
  const cap = <T>(items: T[], render: (item: T) => string) => [
    ...items.slice(0, limit).map(render),
    ...(items.length > limit ? [`- …and ${items.length - limit} more`] : []),
  ];
  const describe = (file: FileDifference) =>
    `- ${links.fork(file.path)}${beforeFiles.get(file.path)?.status === "A" ? " (fork-only before)" : ""}${file.from ? ` (renamed from \`${file.from}\`)` : ""}${file.status === "D" ? " removed" : ""}: +${formatNumber(file.insertions)} −${formatNumber(file.deletions)} from upstream`;

  const tipLine =
    before.upstream === after.upstream
      ? `Both sides are compared with upstream at the in-order tip ${links.upstream(after.upstream)}.`
      : `The in-order tip moves from ${links.upstream(before.upstream)} to ${links.upstream(after.upstream)}.`;
  const lines = [
    ...(labels.marker ? [labels.marker] : []),
    `## ${labels.heading}`,
    "",
    `${tipLine} Excludes \`.repos/\` and \`pnpm-lock.yaml\`.`,
    "",
    `| Measure | ${labels.before} | ${labels.after} | Change |`,
    "| --- | ---: | ---: | ---: |",
    row("Upstream files the fork changes", a.changedFiles, b.changedFiles),
    row(
      "Lines changed in them",
      a.changedInsertions + a.changedDeletions,
      b.changedInsertions + b.changedDeletions,
    ),
    row("Upstream files the fork removes", a.removedFiles, b.removedFiles),
    row("Fork-only files", a.forkOnlyFiles, b.forkOnlyFiles),
    row("Fork-only lines", a.forkOnlyLines, b.forkOnlyLines),
    "",
  ];
  if (starts.length > 0)
    lines.push(
      `### Upstream files that start to differ (${starts.length})`,
      "",
      ...cap(starts, describe),
      "",
    );
  if (returns.length > 0)
    lines.push(
      `### Upstream files that match upstream again (${returns.length})`,
      "",
      ...cap(returns, (file) => `- \`${file.path}\``),
      "",
    );
  if (kept.length > 0)
    lines.push(
      `### Upstream deleted these files and the fork keeps them (${kept.length})`,
      "",
      ...cap(kept, (file) => `- ${links.fork(file.path)}: ${formatNumber(file.insertions)} lines`),
      "",
    );
  if (shifts.length > 0)
    lines.push(
      `<details><summary>Upstream files whose difference changes (${shifts.length})</summary>`,
      "",
      "| File | Change | Now differs by |",
      "| --- | ---: | ---: |",
      ...shifts
        .slice(0, limit)
        .map(
          (shift) =>
            `| ${links.fork(shift.path)} | ${formatSigned(shift.change)} | ${formatNumber(shift.total)} lines |`,
        ),
      ...(shifts.length > limit ? [`| …and ${shifts.length - limit} more | | |`] : []),
      "",
      "</details>",
      "",
    );
  if (starts.length + returns.length + kept.length + shifts.length === 0)
    lines.push("No upstream file changes how much it differs from upstream.", "");
  return lines.join("\n");
}

function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      state: { type: "string", default: ".github/upstream-intake.json" },
      "fork-ref": { type: "string", default: "origin/main" },
      "upstream-ref": { type: "string", default: "upstream/main" },
      base: { type: "string" },
      head: { type: "string" },
      heading: { type: "string", default: "Upstream divergence" },
      "pr-comment": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      [
        "Usage:",
        "  node scripts/upstream/divergence-report.ts [--fork-ref origin/main]",
        "    Prints current divergence from the in-order tip and its daily history.",
        "  node scripts/upstream/divergence-report.ts --base <ref> --head <ref> [--pr-comment]",
        "    Prints how divergence changes from base to head, for a pull request or intake candidate.",
        "Reads fetched refs only.",
      ].join("\n"),
    );
    return;
  }
  const root = NodePath.resolve(import.meta.dirname, "../..");
  const run: Run = (command, args) =>
    NodeChildProcess.execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  const resolve = (ref: string) =>
    run("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
  const tipFor = (ref: string) => {
    const history = readLagHistory(run, ref, values["upstream-ref"], values.state);
    return { history, upstream: inOrderTips(history).at(-1)?.upstream ?? history.base.sha };
  };

  if (values.base || values.head) {
    if (!values.base || !values.head) throw new Error("--base and --head must be used together.");
    const head = resolve(values.head);
    const base = resolve(run("git", ["merge-base", resolve(values.base), head]).trim());
    const baseTip = tipFor(base);
    const headTip = tipFor(head);
    // Links use the base side so a pull request cannot redirect them by editing the state file.
    const repository = `https://github.com/${baseTip.history.upstreamRepository}`;
    process.stdout.write(
      renderComparison(
        readDivergence(run, baseTip.upstream, base),
        readDivergence(run, headTip.upstream, head),
        {
          before: values["pr-comment"] ? "Base" : "Before",
          after: values["pr-comment"] ? "This PR" : "After",
          heading: values.heading,
          ...(values["pr-comment"] ? { marker: "<!-- upstream-divergence -->" } : {}),
        },
        {
          upstream: (sha) => `[\`${sha.slice(0, 10)}\`](${repository}/commit/${sha})`,
          fork: (path) => `\`${path}\``,
        },
        new Set(run("git", ["ls-tree", "-r", "-z", "--name-only", baseTip.upstream]).split("\0")),
      ),
    );
    return;
  }

  const fork = resolve(values["fork-ref"]);
  const { history } = tipFor(fork);
  const tips = inOrderTips(history);
  const repository = `https://github.com/${history.upstreamRepository}`;
  const now = Date.now();
  const daily: Array<{ day: number; totals: DivergenceTotals }> = [];
  for (let day = Math.floor(history.base.time / DAY) * DAY; day <= now; day += DAY) {
    const step = tips.findLast((entry) => entry.time < day + DAY);
    if (!step) continue;
    daily.push({
      day,
      totals: totalDivergence(readDivergence(run, step.upstream, step.fork).files),
    });
  }
  const current = readDivergence(run, tips.at(-1)?.upstream ?? history.base.sha, fork);
  process.stdout.write(
    renderHistory(current, readUpstreamSize(run, current.upstream), daily, {
      upstream: (sha) => `[\`${sha.slice(0, 10)}\`](${repository}/commit/${sha})`,
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
