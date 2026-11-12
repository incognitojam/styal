import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// CHECK_STEP_NAMES maps step ids to names; a step's output is read from check-<id>.log.
const names = JSON.parse(process.env.CHECK_STEP_NAMES);
const steps = JSON.parse(process.env.CHECK_STEPS);
const failed = Object.keys(names).filter((id) => steps[id]?.outcome === "failure");
const summaries = failed.map((id) => {
  let log = "";
  try {
    log = NodeFS.readFileSync(NodePath.join(process.env.RUNNER_TEMP, `check-${id}.log`), "utf8");
  } catch {
    /* Action steps may not have a captured log. */
  }
  const lines = log.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const tests = lines.filter((line) => /^\s*FAIL\s/.test(line));
  const errors = tests.length
    ? tests
    : lines.filter((line) => /error:|Error:|fatal:|ERR_|AssertionError/.test(line));
  const detail = [
    ...new Set(
      errors.map((line) =>
        line
          // Only values that differ between runs of one failure go; package names, URLs and
          // relative file names stay, since they tell two failures apart.
          .replace(/[a-f0-9]{40}/gi, "<commit>")
          .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>")
          .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<time>")
          .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/g, "<duration>")
          .replace(/\b((?:\d{1,3}\.){3}\d{1,3}|localhost|\[[0-9a-f:]+\]):\d+/gi, "$1:<port>")
          .replace(/#\d+\b/g, "#<id>")
          .replace(/(?<![\w@.:\/-])\/(?:home|tmp|var|usr|opt|private|Users)\/[^\s:'")]*/g, "<path>")
          .trim(),
      ),
    ),
  ]
    .sort()
    .join("; ")
    .slice(0, 600);
  return `${names[id]}${detail ? `: ${detail}` : " failed (see job log)"}`;
});
const summary = summaries.join("\n").slice(0, 900) || "Check failed (see job log)";
const directory = NodePath.join(process.env.RUNNER_TEMP, "scheduled-check-summary");
NodeFS.mkdirSync(directory, { recursive: true });
NodeFS.writeFileSync(NodePath.join(directory, "summary.txt"), summary);
NodeFS.appendFileSync(
  process.env.GITHUB_OUTPUT,
  `summary<<CHECK_FAILURE_SUMMARY\n${summary}\nCHECK_FAILURE_SUMMARY\n`,
);
