const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { publish, readBudget, readTools, renderComment } = require("./agent-context-report.cjs");

const MAIN_BUDGET = {
  claudeSystemAppendBytes: 5_493,
  codexAdditionalContextBytes: 6_035,
  mcpToolListJsonBytes: 51_068,
};
const GROWN_BUDGET = { ...MAIN_BUDGET, mcpToolListJsonBytes: 51_446 };
const MAIN_TOOLS = { device_list: 300, t3_thread_read: 400 };
const GROWN_TOOLS = { ...MAIN_TOOLS, read_styal_guide: 378 };

function writeSide(root, side, budget, tools) {
  const directory = path.join(root, side);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "agentContextBudget.json"), JSON.stringify(budget));
  if (tools) {
    fs.writeFileSync(path.join(directory, "agentContextTools.json"), JSON.stringify(tools));
  }
}

async function runPublish(t, { pr, main = {}, comments = [], labels = [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-context-report-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeSide(root, "main", main.budget ?? MAIN_BUDGET, main.tools ?? MAIN_TOOLS);
  writeSide(root, "pr", pr.budget, pr.tools);
  process.env.AGENT_CONTEXT_DIR = root;
  process.env.MAIN_SHA = "a".repeat(40);
  process.env.PR_SHA = "b".repeat(40);

  const calls = { create: [], update: [] };
  const github = {
    paginate: async () => comments,
    rest: {
      issues: {
        listComments: () => undefined,
        createComment: async (input) => calls.create.push(input),
        updateComment: async (input) => calls.update.push(input),
      },
    },
  };
  await publish({
    github,
    context: {
      repo: { owner: "incognitojam", repo: "styal" },
      payload: { pull_request: { number: 7, labels: labels.map((name) => ({ name })) } },
    },
    core: { summary: { addRaw: () => ({ write: async () => {} }) }, info: () => undefined },
  });
  return calls;
}

function bot(body) {
  return { id: 99, user: { type: "Bot", login: "github-actions[bot]" }, body };
}

test("names an added tool and asks for the label", async (t) => {
  const { create, update } = await runPublish(t, {
    pr: { budget: GROWN_BUDGET, tools: GROWN_TOOLS },
  });
  assert.equal(update.length, 0);
  assert.match(create[0].body, /<!-- styal-report:attention -->/);
  assert.equal(create.length, 1);
  const { body, issue_number: issueNumber } = create[0];
  assert.equal(issueNumber, 7);
  assert.match(body, /^<!-- agent-context-budget -->\n/);
  assert.match(body, /fails until a maintainer adds the `agent-context-increase` label/);
  assert.match(body, /\| MCP tool list \| 51,068 \| 51,446 \| \+378 \|/);
  assert.match(body, /\| Claude system append \| 5,493 \| 5,493 \| 0 \|/);
  assert.match(body, /\| `read_styal_guide` \| added \| — \| 378 \| \+378 \|/);
  assert.doesNotMatch(body, /device_list/);
  assert.doesNotMatch(body, /does not match the budget file/);
});

test("sorts added, changed and removed tools by their change", () => {
  const body = renderComment({
    mainBudget: new Map(Object.entries(MAIN_BUDGET)),
    prBudget: new Map(Object.entries({ ...MAIN_BUDGET, mcpToolListJsonBytes: 51_068 + 110 })),
    mainTools: new Map(Object.entries({ removed_tool: 40, resized_tool: 100, same_tool: 5 })),
    prTools: new Map(Object.entries({ added_tool: 130, resized_tool: 120, same_tool: 5 })),
    accepted: false,
    mainSha: "a".repeat(40),
    prSha: "b".repeat(40),
  });
  const rows = body.split("\n").filter((line) => /^\| `/.test(line));
  assert.deepEqual(rows, [
    "| `added_tool` | added | — | 130 | +130 |",
    "| `resized_tool` | changed | 100 | 120 | +20 |",
    "| `removed_tool` | removed | 40 | — | −40 |",
  ]);
  assert.doesNotMatch(body, /does not match the budget file/);
});

test("reports instruction text growth without a tool section", async (t) => {
  const { create } = await runPublish(t, {
    pr: { budget: { ...MAIN_BUDGET, claudeSystemAppendBytes: 5_500 }, tools: MAIN_TOOLS },
  });
  assert.match(create[0].body, /\| Claude system append \| 5,493 \| 5,500 \| \+7 \|/);
  assert.doesNotMatch(create[0].body, /MCP tools with a size change/);
});

test("says when the label accepted the growth", async (t) => {
  const { create } = await runPublish(t, {
    pr: { budget: GROWN_BUDGET, tools: GROWN_TOOLS },
    labels: ["agent-context-increase"],
  });
  assert.match(create[0].body, /A maintainer accepted the growth/);
  assert.match(create[0].body, /<!-- styal-report:quiet -->/);
  assert.doesNotMatch(create[0].body, /fails until/);
});

test("posts nothing when context did not grow and no comment exists", async (t) => {
  const { create, update } = await runPublish(t, {
    pr: { budget: { ...MAIN_BUDGET, mcpToolListJsonBytes: 51_000 }, tools: MAIN_TOOLS },
  });
  assert.deepEqual([create.length, update.length], [0, 0]);
});

test("updates the existing comment when the growth goes away", async (t) => {
  const { create, update } = await runPublish(t, {
    pr: { budget: MAIN_BUDGET, tools: MAIN_TOOLS },
    comments: [bot("<!-- agent-context-budget -->\nold")],
  });
  assert.equal(create.length, 0);
  assert.equal(update[0].comment_id, 99);
  assert.match(update[0].body, /no longer larger than `main`/);
  assert.doesNotMatch(update[0].body, /<!-- styal-report:quiet -->/);
  const healthy = await runPublish(t, {
    pr: { budget: MAIN_BUDGET, tools: MAIN_TOOLS },
    comments: [bot(update[0].body)],
  });
  assert.match(healthy.update[0].body, /<!-- styal-report:quiet -->/);
  const unchanged = await runPublish(t, {
    pr: { budget: MAIN_BUDGET, tools: MAIN_TOOLS },
    comments: [bot(healthy.update[0].body)],
  });
  assert.equal(unchanged.update.length, 0);
});

test("ignores comments that are not its own and skips an unchanged update", async (t) => {
  const first = await runPublish(t, {
    pr: { budget: GROWN_BUDGET, tools: GROWN_TOOLS },
    comments: [
      { id: 1, user: { type: "User" }, body: "<!-- agent-context-budget -->\nquoted" },
      bot("<!-- upstream-divergence -->"),
    ],
  });
  assert.equal(first.create.length, 1);

  const second = await runPublish(t, {
    pr: { budget: GROWN_BUDGET, tools: GROWN_TOOLS },
    comments: [bot(first.create[0].body)],
  });
  assert.deepEqual([second.create.length, second.update.length], [0, 0]);
});

test("reports totals and explains the gap when a side has no tool sizes", async (t) => {
  const { create } = await runPublish(t, { pr: { budget: GROWN_BUDGET } });
  assert.match(create[0].body, /\| MCP tool list \| 51,068 \| 51,446 \| \+378 \|/);
  assert.match(create[0].body, /The tools behind the tool list change are not available/);
});

test("flags tool sizes that do not add up to the budget change", async (t) => {
  const { create } = await runPublish(t, {
    pr: { budget: GROWN_BUDGET, tools: { ...MAIN_TOOLS, read_styal_guide: 300 } },
  });
  assert.match(create[0].body, /add up to \+300 bytes, but the tool list changed by \+378 bytes/);
});

test("rejects files that could inject Markdown into the comment", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-context-report-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (budget, tools) => writeSide(root, "pr", budget, tools);

  write(MAIN_BUDGET, { "tool` @everyone |": 1 });
  assert.equal(readTools(path.join(root, "pr")), undefined);
  write({ "key @everyone": 1 }, MAIN_TOOLS);
  assert.equal(readBudget(path.join(root, "pr")), undefined);
  write({ claudeSystemAppendBytes: "lots" }, MAIN_TOOLS);
  assert.equal(readBudget(path.join(root, "pr")), undefined);
  write(MAIN_BUDGET, { tool: -1 });
  assert.equal(readTools(path.join(root, "pr")), undefined);
  write(MAIN_BUDGET, MAIN_TOOLS);
  fs.writeFileSync(path.join(root, "pr", "agentContextTools.json"), "not json");
  assert.equal(readTools(path.join(root, "pr")), undefined);
  fs.writeFileSync(path.join(root, "pr", "agentContextTools.json"), "x".repeat(70_000));
  assert.equal(readTools(path.join(root, "pr")), undefined);
});
