const { prepareReport, OK, ATTENTION } = require("./quiet-report.cjs");
const fs = require("node:fs");
const path = require("node:path");

const COMMENT_MARKER = "<!-- agent-context-budget -->";
const INCREASE_LABEL = "agent-context-increase";
const MAX_FILE_BYTES = 64 * 1_024;
const TOOL_LIST_KEY = "mcpToolListJsonBytes";
const BUDGET_LABELS = {
  claudeSystemAppendBytes: "Claude system append",
  codexAdditionalContextBytes: "Codex additional context",
  [TOOL_LIST_KEY]: "MCP tool list",
};

// A fork PR controls these files, and their contents reach a comment posted by a write token.
function readSizes(directory, fileName, isAllowedKey) {
  const file = path.join(directory, fileName);
  if (!fs.existsSync(file)) return undefined;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const entries = Object.entries(parsed);
  const valid = entries.every(
    ([key, value]) => isAllowedKey(key) && Number.isSafeInteger(value) && value >= 0,
  );
  return valid ? new Map(entries) : undefined;
}

function readBudget(directory) {
  return readSizes(directory, "agentContextBudget.json", (key) => /^[A-Za-z0-9_]+$/.test(key));
}

function readTools(directory) {
  return readSizes(directory, "agentContextTools.json", (key) => /^[A-Za-z0-9_.-]+$/.test(key));
}

// Matches the gate in agent-context-budget.yml: a value counts only if the base also has it.
function hasGrowth(baseBudget, prBudget) {
  return [...prBudget].some(
    ([key, value]) => baseBudget.get(key) !== undefined && value > baseBudget.get(key),
  );
}

function formatChange(delta) {
  if (delta === 0) return "0";
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta).toLocaleString("en-US")}`;
}

function formatSize(value) {
  return value === undefined ? "—" : value.toLocaleString("en-US");
}

function budgetRows(baseBudget, prBudget) {
  return [...new Set([...baseBudget.keys(), ...prBudget.keys()])].map((key) => {
    const before = baseBudget.get(key);
    const after = prBudget.get(key);
    return `| ${BUDGET_LABELS[key] ?? `\`${key}\``} | ${formatSize(before)} | ${formatSize(after)} | ${formatChange((after ?? 0) - (before ?? 0))} |`;
  });
}

function changedTools(baseTools, prTools) {
  return [...new Set([...baseTools.keys(), ...prTools.keys()])]
    .map((name) => {
      const before = baseTools.get(name);
      const after = prTools.get(name);
      const status = before === undefined ? "added" : after === undefined ? "removed" : "changed";
      return { name, status, before, after, delta: (after ?? 0) - (before ?? 0) };
    })
    .filter((tool) => tool.delta !== 0)
    .toSorted((left, right) => right.delta - left.delta || (left.name < right.name ? -1 : 1));
}

function toolSection({ baseBudget, prBudget, baseTools, prTools, baseRef }) {
  const before = baseBudget.get(TOOL_LIST_KEY);
  const after = prBudget.get(TOOL_LIST_KEY);
  if (before === undefined || after === undefined || before === after) return [];
  if (!baseTools || !prTools) {
    return [
      "",
      `The tools behind the tool list change are not available because \`${baseRef}\` or this PR has no readable \`apps/server/src/provider/agentContextTools.json\`. Rebasing onto \`${baseRef}\` and running \`vp test run AgentContextBudget -u\` adds it.`,
    ];
  }
  const tools = changedTools(baseTools, prTools);
  const total = after - before;
  const listed = tools.reduce((sum, tool) => sum + tool.delta, 0);
  return [
    "",
    "### MCP tools with a size change",
    "",
    ...(tools.length === 0
      ? ["No tool has a size change in `agentContextTools.json`."]
      : [
          `| Tool | Status | \`${baseRef}\` | This PR | Change |`,
          "| --- | --- | ---: | ---: | ---: |",
          ...tools.map(
            (tool) =>
              `| \`${tool.name}\` | ${tool.status} | ${formatSize(tool.before)} | ${formatSize(tool.after)} | ${formatChange(tool.delta)} |`,
          ),
        ]),
    ...(listed === total
      ? []
      : [
          "",
          `These tools add up to ${formatChange(listed)} bytes, but the tool list changed by ${formatChange(total)} bytes, so \`agentContextTools.json\` does not match the budget file. \`AgentContextBudget.test.ts\` fails until it does.`,
        ]),
  ];
}

function statusLine(grown, accepted, baseRef) {
  if (!grown) {
    return `Agent context is no longer larger than \`${baseRef}\`, so this PR does not need the \`agent-context-increase\` label.`;
  }
  if (accepted) {
    return `Agent context grew compared to \`${baseRef}\`. A maintainer accepted the growth with the \`agent-context-increase\` label.`;
  }
  return `Agent context grew compared to \`${baseRef}\`. The Agent context budget check fails until a maintainer adds the \`agent-context-increase\` label or this PR removes the growth.`;
}

function renderComment(input) {
  const { baseBudget, prBudget, accepted, baseSha, prSha, baseRef } = input;
  return [
    COMMENT_MARKER,
    hasGrowth(baseBudget, prBudget) && !accepted ? ATTENTION : OK,
    "## Agent context growth",
    "",
    statusLine(hasGrowth(baseBudget, prBudget), accepted, baseRef),
    "",
    "Agent context is the instructions and MCP tool list styal sends into every user's agent session. Sizes are UTF-8 bytes.",
    "",
    `| Context | \`${baseRef}\` | This PR | Change |`,
    "| --- | ---: | ---: | ---: |",
    ...budgetRows(baseBudget, prBudget),
    ...toolSection(input),
    "",
    `Compared \`${baseRef}\` at \`${baseSha.slice(0, 7)}\` with this PR at \`${prSha.slice(0, 7)}\`.`,
    "",
  ].join("\n");
}

async function publish({ github, context, core }) {
  const { owner, repo } = context.repo;
  const pull = context.payload.pull_request;
  const directory = process.env.AGENT_CONTEXT_DIR;
  const baseBudget = readBudget(path.join(directory, "base"));
  const prBudget = readBudget(path.join(directory, "pr"));
  if (!baseBudget || !prBudget) {
    core.info(
      `${pull.base.ref} or this PR has no readable agent context budget; nothing to report.`,
    );
    return;
  }

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pull.number,
    per_page: 100,
  });
  const existing = comments.find(
    (comment) =>
      comment.user?.login === "github-actions[bot]" && comment.body?.startsWith(COMMENT_MARKER),
  );
  const body = prepareReport(
    renderComment({
      baseBudget,
      prBudget,
      baseTools: readTools(path.join(directory, "base")),
      prTools: readTools(path.join(directory, "pr")),
      accepted: pull.labels.some((label) => label.name === INCREASE_LABEL),
      baseRef: pull.base.ref,
      baseSha: process.env.BASE_SHA,
      prSha: process.env.PR_SHA,
    }),
    existing?.body,
  );
  await core.summary.addRaw(body).write();
  // A PR that never grew gets no comment. Once one exists, it stays and reports the current state.
  if (!existing && !hasGrowth(baseBudget, prBudget)) {
    core.info(`Agent context is not larger than ${pull.base.ref}; no comment needed.`);
    return;
  }

  if (!existing) {
    await github.rest.issues.createComment({ owner, repo, issue_number: pull.number, body });
  } else if (existing.body !== body) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  }
}

module.exports = { publish, readBudget, readTools, renderComment };
