import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const names = {
  paths: "Set paths",
  checkout: "Checkout",
  setup: "Setup Vite+",
  upstream: "Check out upstream T3 Code",
  install: "Install upstream dependencies",
  generate: "Generate T3 Code data",
  import: "Import into styal",
};
const steps = JSON.parse(process.env.CHECK_STEPS);
const failed = Object.keys(names).filter((id) => steps[id]?.outcome === "failure");
const summaries = failed.map((id) => {
  let log = "";
  try {
    log = NodeFS.readFileSync(NodePath.join(process.env.RUNNER_TEMP, `import-${id}.log`), "utf8");
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
          .replace(/[a-f0-9]{40}/gi, "<commit>")
          .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/g, "<duration>")
          .replace(/\/(?:[^\s:]+\/)*[^\s:]+/g, "<path>")
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
  `summary<<IMPORT_FAILURE_SUMMARY\n${summary}\nIMPORT_FAILURE_SUMMARY\n`,
);
