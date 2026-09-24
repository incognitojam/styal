#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - Local, synchronous maintainer CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { readLagHistory, replayIntake } from "./upstream-lag-report.ts";
import { decodeState } from "./upstream-queue.ts";
import {
  decodeTrackedPRs,
  fetchTrackedPRMetadata,
  trackedPRStatuses,
  type TrackedPRStatus,
} from "./upstream-tracked-prs.ts";

export function renderTrackedPRReport(
  repository: string,
  statuses: readonly TrackedPRStatus[],
): string {
  const rows = statuses.map((pr) => {
    const title = pr.title.replaceAll("|", "\\|").replaceAll("\n", " ");
    const status = `${pr.status}${pr.beyondTarget ? " (beyond target)" : ""}`;
    return `| [#${pr.number}](https://github.com/${repository}/pull/${pr.number}) | ${title} | ${status} | ${pr.mergedAt?.slice(0, 10) ?? "—"} | ${pr.daysAheadOfTip === null ? "—" : `${pr.daysAheadOfTip.toFixed(1)} days`} |`;
  });
  return [
    "## Tracked upstream PRs",
    "",
    "| PR | Upstream change | Intake | Merged | Ahead of fork tip |",
    "| --- | --- | --- | --- | ---: |",
    ...rows,
    "",
    "Recorded means import evidence or reviewed baseline coverage exists; it does not prove the current behavior still works. Ahead of fork tip compares each pending PR's upstream merge time with the fork's last reconciled upstream integration. This report does not change intake order.",
    "",
  ].join("\n");
}

function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      state: { type: "string", default: ".github/upstream-intake.json" },
      tracked: { type: "string", default: ".github/upstream-tracked-prs.json" },
      "fork-ref": { type: "string", default: "origin/main" },
      "upstream-ref": { type: "string", default: "upstream/main" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node scripts/upstream-tracked-prs-report.ts [--fork-ref origin/main] [--upstream-ref upstream/main]\nPrints a Markdown report for tracked upstream PRs. Reads fetched refs and GitHub PR metadata.",
    );
    return;
  }
  const root = NodePath.resolve(import.meta.dirname, "..");
  const run = (command: string, args: string[]) =>
    NodeChildProcess.execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  const state = decodeState(NodeFS.readFileSync(NodePath.resolve(root, values.state), "utf8"));
  const history = readLagHistory(run, values["fork-ref"], values["upstream-ref"], values.state);
  const tip = replayIntake(history).steps.at(-1)?.tip ?? 0;
  const tipMergedAt = history.upstream
    .slice(0, tip)
    .reduce((time, integration) => Math.max(time, integration.time), history.base.time);
  const tracked = decodeTrackedPRs(
    NodeFS.readFileSync(NodePath.resolve(root, values.tracked), "utf8"),
  );
  const chain = (ref: string) =>
    new Set(run("git", ["rev-list", "--first-parent", ref]).trim().split("\n"));
  const forkLog = run("git", ["log", "--format=%H%x00%B%x00", values["fork-ref"]]).split("\0");
  const forkCommits: { sha: string; message: string }[] = [];
  for (let index = 0; index + 1 < forkLog.length; index += 2)
    forkCommits.push({ sha: forkLog[index]!.trim(), message: forkLog[index + 1]! });
  const statuses = trackedPRStatuses({
    tracked,
    metadata: fetchTrackedPRMetadata(state.upstreamRepository, tracked, run),
    entries: [],
    forkCommits,
    upstreamFirstParent: chain(values["upstream-ref"]),
    targetFirstParent: chain(state.target),
    baselineFirstParent: chain(state.baseline),
    exceptions: state.exceptions,
    tipMergedAt,
  });
  process.stdout.write(renderTrackedPRReport(state.upstreamRepository, statuses));
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
