#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - Local, synchronous maintainer CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { parseUpstreamProvenance } from "./upstream-provenance.ts";
import { decodeState } from "./upstream-queue.ts";

type Run = (command: string, args: string[]) => string;

const DAY = 86_400_000;

export interface UpstreamIntegration {
  /** 1-based position on upstream main's first-parent chain after the divergence point. */
  index: number;
  sha: string;
  time: number;
  pr: number | null;
}

export interface ForkCommit {
  sha: string;
  time: number;
  authoredTime: number;
  /** Upstream integration indexes named by the commit's provenance metadata. */
  sources: number[];
  /** Upstream index of the intake baseline when this commit changed the state file. */
  baseline: number | null;
}

export interface LagHistory {
  upstreamRepository: string;
  base: { sha: string; time: number };
  upstream: UpstreamIntegration[];
  fork: ForkCommit[];
}

export interface IntakeReplay {
  /** Fork state after each fork commit. Times never decrease. */
  steps: Array<{ time: number; tip: number; accounted: number }>;
  imports: Array<{ index: number; time: number; order: "in order" | "early" }>;
}

export interface LagSnapshot {
  time: number;
  upstream: number;
  tip: number;
  accounted: number;
  behind: number;
  ageDays: number;
}

export interface LagDay extends LagSnapshot {
  day: number;
  merged: number;
  inOrder: number;
  early: number;
}

export interface LagSummary {
  current: LagSnapshot;
  windowDays: number;
  tipPace: number;
  upstreamPace: number;
  catchUpDays: number | null;
  tipTimes: number[];
  days: LagDay[];
}

/** Reads fork and upstream first-parent history since their merge base. */
export function readLagHistory(
  run: Run,
  forkRef: string,
  upstreamRef: string,
  statePath: string,
): LagHistory {
  const resolve = (ref: string) =>
    run("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
  const fork = resolve(forkRef);
  const upstreamHead = resolve(upstreamRef);
  const base = run("git", ["merge-base", fork, upstreamHead]).trim();
  const records = (format: string, range: string, ...paths: string[]) =>
    run("git", [
      "log",
      "--first-parent",
      "--reverse",
      `--format=${format}%x1e`,
      range,
      ...(paths.length > 0 ? ["--", ...paths] : []),
    ])
      .split("\x1e")
      .map((record) => record.replace(/^\n/u, ""))
      .filter(Boolean)
      .map((record) => record.split("\x1f"));

  const upstream = records("%H%x1f%ct%x1f%s", `${base}..${upstreamHead}`).map(
    ([sha, time, subject], index): UpstreamIntegration => {
      const pr = subject!.match(/\(#(\d+)\)$/u)?.[1];
      return { index: index + 1, sha: sha!, time: Number(time) * 1000, pr: pr ? Number(pr) : null };
    },
  );
  const bySha = new Map(upstream.map((integration) => [integration.sha, integration.index]));
  const byPr = new Map<number, number[]>();
  for (const integration of upstream) {
    if (integration.pr !== null)
      byPr.set(integration.pr, [...(byPr.get(integration.pr) ?? []), integration.index]);
  }

  const stateCommits = new Set(records("%H", `${base}..${fork}`, statePath).map(([sha]) => sha));
  const forkCommits = records("%H%x1f%ct%x1f%at%x1f%B", `${base}..${fork}`).map(
    ([sha, time, authoredTime, message]): ForkCommit => {
      const provenance = parseUpstreamProvenance([message!]);
      const cherryPicks = [
        ...message!.matchAll(/\(cherry picked from commit ([0-9a-f]{40})\)/gu),
      ].map((match) => match[1]!);
      const sources = new Set([
        ...[...provenance.commitShas, ...cherryPicks].flatMap((source) => bySha.get(source) ?? []),
        ...provenance.pullRequestNumbers.flatMap((pr) => byPr.get(pr) ?? []),
      ]);
      const baseline = stateCommits.has(sha!)
        ? (bySha.get(JSON.parse(run("git", ["show", `${sha}:${statePath}`])).baseline) ?? 0)
        : null;
      return {
        sha: sha!,
        time: Number(time) * 1000,
        authoredTime: Number(authoredTime) * 1000,
        sources: [...sources].sort((a, b) => a - b),
        baseline,
      };
    },
  );

  return {
    upstreamRepository: decodeState(run("git", ["show", `${fork}:${statePath}`]))
      .upstreamRepository,
    base: { sha: base, time: Number(run("git", ["log", "-1", "--format=%ct", base])) * 1000 },
    upstream,
    fork: forkCommits,
  };
}

/**
 * Replays fork history to find when each upstream integration became accounted for, either by an
 * import or by a baseline advance. The in-order tip is the longest accounted prefix of upstream;
 * an import is early when an older integration was still unaccounted for when it landed.
 */
export function replayIntake(history: LagHistory): IntakeReplay {
  const accounted = new Uint8Array(history.upstream.length + 1);
  let tip = 0;
  let accountedCount = 0;
  let time = -Infinity;
  const steps: IntakeReplay["steps"] = [];
  const imports: IntakeReplay["imports"] = [];
  const account = (index: number) => {
    if (accounted[index]) return false;
    accounted[index] = 1;
    accountedCount++;
    return true;
  };
  const advance = () => {
    while (tip < history.upstream.length && accounted[tip + 1]) tip++;
  };
  for (const commit of history.fork) {
    time = Math.max(time, commit.time);
    for (const index of commit.sources) {
      if (!account(index)) continue;
      imports.push({ index, time, order: index === tip + 1 ? "in order" : "early" });
      advance();
    }
    for (let index = 1; index <= (commit.baseline ?? 0); index++) account(index);
    advance();
    steps.push({ time, tip, accounted: accountedCount });
  }
  return { steps, imports };
}

export function summarizeLag(
  history: LagHistory,
  replay: IntakeReplay,
  now: number,
  windowDays = 3,
): LagSummary {
  // Merge time of each tip index, kept monotone so the tip never looks younger than an older integration.
  const tipTimes = [history.base.time];
  for (const integration of history.upstream)
    tipTimes.push(Math.max(tipTimes.at(-1)!, integration.time));
  const at = (time: number): LagSnapshot => {
    const upstream = history.upstream.filter((integration) => integration.time <= time).length;
    const step = replay.steps.findLast((candidate) => candidate.time <= time) ?? {
      tip: 0,
      accounted: 0,
    };
    return {
      time,
      upstream,
      tip: step.tip,
      accounted: step.accounted,
      behind: Math.max(0, upstream - step.tip),
      ageDays: (time - tipTimes[step.tip]!) / DAY,
    };
  };
  const current = at(now);
  const before = at(now - windowDays * DAY);
  const tipPace = (current.tip - before.tip) / windowDays;
  const upstreamPace = (current.upstream - before.upstream) / windowDays;
  const net = tipPace - upstreamPace;

  const days: LagDay[] = [];
  for (let day = Math.floor(history.base.time / DAY) * DAY; day <= now; day += DAY) {
    const within = (time: number) => time >= day && time < day + DAY;
    const imports = replay.imports.filter((entry) => within(entry.time));
    days.push({
      ...at(Math.min(day + DAY - 1, now)),
      day,
      merged: history.upstream.filter((integration) => within(integration.time)).length,
      inOrder: imports.filter((entry) => entry.order === "in order").length,
      early: imports.filter((entry) => entry.order === "early").length,
    });
  }
  return {
    current,
    windowDays,
    tipPace,
    upstreamPace,
    catchUpDays: net > 0 ? current.behind / net : null,
    tipTimes,
    days,
  };
}

const formatNumber = (value: number) => value.toLocaleString("en-US");
const formatDay = (time: number) =>
  new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const formatTime = (time: number) =>
  `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Rounds an axis maximum up to a step of 1, 2, 2.5, 4 or 5 times a power of ten. */
function axisMax(value: number): number {
  const rough = Math.max(value, 1) / 5;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 4, 5, 10].map((m) => m * power).find((candidate) => candidate >= rough)!;
  return Math.ceil(value / step) * step;
}

// Validated categorical palette; the same mid-tone colors read on GitHub's light and dark themes.
const BLUE = "#2a78d6";
const ORANGE = "#eb6834";
const GREEN = "#1baf7a";

function xyChart(chart: {
  title: string;
  yAxis: string;
  labels: string[];
  series: Array<{ kind: "line" | "bar"; color: string; values: number[] }>;
}): string {
  const max = axisMax(Math.max(...chart.series.flatMap((series) => series.values)));
  const config = {
    xyChart: { width: 900, height: 360 },
    themeVariables: {
      xyChart: { plotColorPalette: chart.series.map((series) => series.color).join(", ") },
    },
  };
  return [
    "```mermaid",
    `%%{init: ${JSON.stringify(config)}}%%`,
    "xychart-beta",
    `  title "${chart.title}"`,
    `  x-axis [${chart.labels.map((label) => `"${label}"`).join(", ")}]`,
    `  y-axis "${chart.yAxis}" 0 --> ${max}`,
    ...chart.series.map((series) => `  ${series.kind} [${series.values.join(", ")}]`),
    "```",
  ].join("\n");
}

export function renderLagReport(
  history: LagHistory,
  replay: IntakeReplay,
  summary: LagSummary,
  refs: { fork: string; upstream: string },
): string {
  const { current, days } = summary;
  const repository = `https://github.com/${history.upstreamRepository}`;
  const commitLink = (sha: string) => `[\`${sha.slice(0, 10)}\`](${repository}/commit/${sha})`;
  const tip = history.upstream[current.tip - 1];
  const tipLabel = tip
    ? `${commitLink(tip.sha)}${tip.pr === null ? "" : ` ([#${tip.pr}](${repository}/pull/${tip.pr}))`}`
    : `the divergence point ${commitLink(history.base.sha)}`;
  const peak = days.reduce((best, day) => (day.behind > best.behind ? day : best), days[0]!);
  const net = summary.tipPace - summary.upstreamPace;
  const inOrder = replay.imports.filter((entry) => entry.order === "in order").length;
  const early = replay.imports.length - inOrder;
  const forkWork = history.fork.filter((commit) => commit.sources.length === 0);
  const rebased = forkWork.filter((commit) => commit.authoredTime < history.base.time).length;

  // Keep the time axis readable by sampling long histories; the last day is always shown.
  const stride = Math.ceil(days.length / 40);
  const sampled = days.filter((_, index) => (days.length - 1 - index) % stride === 0);
  const recent = days.slice(-30);
  // Mermaid draws every category label, so only the first label and month starts carry the month.
  const labels = (rows: LagDay[]) =>
    rows.map((row, index) => {
      const date = new Date(row.day);
      const month = date.getUTCMonth() !== new Date(rows[index - 1]?.day ?? NaN).getUTCMonth();
      return month ? `${date.getUTCMonth() + 1}/${date.getUTCDate()}` : String(date.getUTCDate());
    });

  const lines = [
    "## Upstream lag",
    "",
    `Fork \`${refs.fork}\` compared with \`${history.upstreamRepository}\` \`${refs.upstream}\`, measured ${formatTime(current.time)}. The histories diverged at ${commitLink(history.base.sha)} (${formatTime(history.base.time)}); upstream has merged ${formatNumber(current.upstream)} first-parent integrations since.`,
    "",
    "| Measure | Value |",
    "| --- | --- |",
    `| Behind, in order | **${formatNumber(current.behind)}** integrations, ${formatNumber(current.accounted - current.tip)} of them already imported early |`,
    `| In-order tip | ${tipLabel}, merged upstream ${formatDay(summary.tipTimes[current.tip]!)}, **${current.ageDays.toFixed(1)} days** behind upstream |`,
    `| Pace, last ${summary.windowDays} days | In-order tip +${Math.round(summary.tipPace)}/day, upstream +${Math.round(summary.upstreamPace)}/day: the gap ${net >= 0 ? "shrinks" : "grows"} by ${Math.abs(Math.round(net))}/day |`,
    `| Caught up at this pace | ${summary.catchUpDays === null ? "Not converging" : `${formatDay(current.time + summary.catchUpDays * DAY)} (${Math.round(summary.catchUpDays)} days)`} |`,
    `| Largest gap | ${formatNumber(peak.behind)} on ${formatDay(peak.day)} |`,
    "",
    "### Upstream merged vs fork progress",
    "",
    "🟦 Upstream merged · 🟧 Fork, in order · 🟩 Fork, in any order",
    "",
    xyChart({
      title: "Upstream integrations since the divergence point",
      yAxis: "Integrations",
      labels: labels(sampled),
      series: [
        { kind: "line", color: BLUE, values: sampled.map((row) => row.upstream) },
        { kind: "line", color: ORANGE, values: sampled.map((row) => row.tip) },
        { kind: "line", color: GREEN, values: sampled.map((row) => row.accounted) },
      ],
    }),
    "",
    "### Integrations behind, in order",
    "",
    xyChart({
      title: "Upstream integrations not yet reached by the in-order tip",
      yAxis: "Integrations",
      labels: labels(sampled),
      series: [{ kind: "line", color: ORANGE, values: sampled.map((row) => row.behind) }],
    }),
    "",
    "### Age of the in-order tip",
    "",
    "Days since upstream merged the in-order tip. A line rising one day per day means no in-order intake; a falling line means the fork is catching up.",
    "",
    xyChart({
      title: "Age of the in-order tip",
      yAxis: "Days",
      labels: labels(sampled),
      series: [
        {
          kind: "line",
          color: ORANGE,
          values: sampled.map((row) => Number(row.ageDays.toFixed(1))),
        },
      ],
    }),
    "",
    "### Daily throughput",
    "",
    "🟧 Imported in order (bars) · 🟦 Merged upstream (line)",
    "",
    xyChart({
      title: `Integrations per day, last ${recent.length} days`,
      yAxis: "Integrations",
      labels: labels(recent),
      series: [
        { kind: "bar", color: ORANGE, values: recent.map((row) => row.inOrder) },
        { kind: "line", color: BLUE, values: recent.map((row) => row.merged) },
      ],
    }),
    "",
    "### Composition",
    "",
    "| Fork first-parent commits since divergence | Count |",
    "| --- | ---: |",
    `| Fork work authored before the divergence (rebased) | ${formatNumber(rebased)} |`,
    `| Fork work authored after the divergence | ${formatNumber(forkWork.length - rebased)} |`,
    `| Commits carrying upstream provenance | ${formatNumber(history.fork.length - forkWork.length)} |`,
    `| **Total** | **${formatNumber(history.fork.length)}** |`,
    "",
    "| Upstream integrations since divergence | Count |",
    "| --- | ---: |",
    `| Imported in order | ${formatNumber(inOrder)} |`,
    `| Imported early | ${formatNumber(early)} |`,
    `| Reconciled only by a baseline advance | ${formatNumber(current.accounted - replay.imports.length)} |`,
    `| Not yet accounted for | ${formatNumber(history.upstream.length - current.accounted)} |`,
    `| **Total** | **${formatNumber(history.upstream.length)}** |`,
    "",
    "<details><summary>Daily values</summary>",
    "",
    "| End of day (UTC) | Upstream merged | Fork in order | Fork any order | Behind | Tip age (days) | Merged that day | Imported in order | Imported early |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...days.map(
      (row) =>
        `| ${formatDay(row.day)} | ${formatNumber(row.upstream)} | ${formatNumber(row.tip)} | ${formatNumber(row.accounted)} | ${formatNumber(row.behind)} | ${row.ageDays.toFixed(1)} | ${row.merged} | ${row.inOrder} | ${row.early} |`,
    ),
    "",
    "</details>",
    "",
    `Upstream integrations are first-parent commits on upstream main after the divergence point. A fork commit imports one when its \`Upstream-PR\`, \`Upstream-Commit\`, or \`cherry picked from\` metadata names it, and baseline advances in the intake state file account for everything up to the baseline. The in-order tip is the longest accounted prefix of upstream, matching \`upstream-queue.ts status\`. Fork times are committer times on \`${refs.fork}\`, which approximate when intake landed. The catch-up date assumes both ${summary.windowDays}-day paces hold.`,
    "",
  ];
  return lines.join("\n");
}

function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      state: { type: "string", default: ".github/upstream-intake.json" },
      "fork-ref": { type: "string", default: "origin/main" },
      "upstream-ref": { type: "string", default: "upstream/main" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node scripts/upstream-lag-report.ts [--fork-ref origin/main] [--upstream-ref upstream/main]\nPrints a Markdown report of how far the fork trails upstream. Reads fetched refs only.",
    );
    return;
  }
  const root = NodePath.resolve(import.meta.dirname, "..");
  const run: Run = (command, args) =>
    NodeChildProcess.execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  const history = readLagHistory(run, values["fork-ref"], values["upstream-ref"], values.state);
  const replay = replayIntake(history);
  const summary = summarizeLag(history, replay, Date.now());
  process.stdout.write(
    renderLagReport(history, replay, summary, {
      fork: values["fork-ref"],
      upstream: values["upstream-ref"],
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
