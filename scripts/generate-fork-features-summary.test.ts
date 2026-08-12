// @effect-diagnostics globalDate:off - Fixed native dates keep rendered release metadata deterministic.
import { assert, describe, it } from "@effect/vitest";
import {
  collectChangeEvidence,
  extractResponseText,
  filterDesktopUpdateRecords,
  fitEvidenceToPromptBudget,
  parseChangeRecords,
  parseChangelogSummary,
  parsePullRequestNumber,
  renderForkFeaturesSummary,
  renderNightlySummary,
  restrictSummaryToEvidence,
  sanitizePullRequestBody,
  type ChangeEvidence,
  type ChangeRecord,
  type RepositoryCommit,
} from "./generate-fork-features-summary.ts";

const commits: ReadonlyArray<RepositoryCommit> = [
  {
    repository: "yngatech/t3code",
    sha: "a".repeat(40),
    subject: "feat(web): show GitHub service outages (#14)",
    body: "feat(web): make GitHub outage alerts opt-in",
    diff: "+ const notice = useGitHubStatus();",
    files: ["apps/web/src/components/sidebar/GitHubStatusNotice.tsx"],
  },
];

const evidence: ReadonlyArray<ChangeEvidence> = [
  {
    id: "yngatech/t3code#14",
    repository: "yngatech/t3code",
    sha: "a".repeat(40),
    title: "feat(web): show GitHub service outages",
    description:
      "GitHub incidents looked like T3 Code failures. Show affected services in the sidebar.",
    diff: "+ const notice = useGitHubStatus();",
    files: ["apps/web/src/components/sidebar/GitHubStatusNotice.tsx"],
  },
];

const records: ReadonlyArray<ChangeRecord> = [
  {
    evidenceId: "yngatech/t3code#14",
    operation: "add",
    capability: "GitHub outage status",
    outcome: "Detect GitHub outages and show affected services",
    surface: "web",
  },
];

describe("fork features summary", () => {
  it("extracts pull request numbers only from merged commit subjects", () => {
    assert.equal(parsePullRequestNumber("feat(web): show outages (#14)"), 14);
    assert.equal(parsePullRequestNumber("fix: retain literal #14"), undefined);
    assert.equal(parsePullRequestNumber("fix: invalid (#0)"), undefined);
  });

  it("keeps the useful PR description and removes secondary automation sections", () => {
    const body = `## Problem

Setup outcomes were invisible.

## Fix

Show the final result in the timeline.

## Screenshots

![Result](https://example.com/result.png)

## Verification

- tests passed

<!-- codesmith:footer -->generated`;

    assert.equal(
      sanitizePullRequestBody(body),
      "## Problem\n\nSetup outcomes were invisible.\n\n## Fix\n\nShow the final result in the timeline.",
    );
  });

  it("prefers PR titles and descriptions over squash commit metadata", async () => {
    const requests: Array<{ readonly authorization: string | null; readonly url: string }> = [];
    const fetchPull = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({ authorization: headers.get("Authorization"), url: String(input) });
      return new Response(
        JSON.stringify({
          title: "feat(web): show GitHub service outages",
          body: "Show affected GitHub services in the sidebar.\n\n## Verification\n\nDone.",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    assert.deepEqual(await collectChangeEvidence(commits, "github-token", fetchPull), [
      {
        id: "yngatech/t3code#14",
        repository: "yngatech/t3code",
        sha: "a".repeat(40),
        title: "feat(web): show GitHub service outages",
        description: "Show affected GitHub services in the sidebar.",
        diff: "+ const notice = useGitHubStatus();",
        files: ["apps/web/src/components/sidebar/GitHubStatusNotice.tsx"],
      },
    ]);
    assert.deepEqual(requests, [
      {
        authorization: "Bearer github-token",
        url: "https://api.github.com/repos/yngatech/t3code/pulls/14",
      },
    ]);
  });

  it("falls back to commit metadata when a commit has no pull request", async () => {
    const directCommit = { ...commits[0]!, subject: "feat(web): show GitHub service outages" };
    const collected = await collectChangeEvidence([directCommit], undefined, async () => {
      throw new Error("fetch should not run");
    });

    assert.deepEqual(collected, [
      {
        id: `yngatech/t3code@${"a".repeat(12)}`,
        repository: "yngatech/t3code",
        sha: "a".repeat(40),
        title: "feat(web): show GitHub service outages",
        description: "feat(web): make GitHub outage alerts opt-in",
        diff: "+ const notice = useGitHubStatus();",
        files: ["apps/web/src/components/sidebar/GitHubStatusNotice.tsx"],
      },
    ]);
  });

  it("drops the largest diffs first when evidence exceeds the prompt budget", () => {
    const oversized: ReadonlyArray<ChangeEvidence> = [
      { ...evidence[0]!, id: "yngatech/t3code#20", diff: "small diff" },
      { ...evidence[0]!, id: "yngatech/t3code#21", diff: "x".repeat(200_000) },
    ];

    const fitted = fitEvidenceToPromptBudget(oversized);

    assert.equal(fitted[0]?.diff, "small diff");
    assert.equal(fitted[1]?.diff, "");
    assert.deepEqual(fitEvidenceToPromptBudget(evidence), evidence);
  });

  it("extracts and validates structured response text", () => {
    const text = extractResponseText({
      output: [
        { type: "reasoning", content: [] },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({ changes: records }),
            },
          ],
        },
      ],
    });

    assert.deepEqual(parseChangeRecords(text), records);
  });

  it("rejects non-canonical change surfaces", () => {
    assert.throws(() =>
      parseChangeRecords(
        JSON.stringify({ changes: [{ ...records[0], surface: "mobile settings" }] }),
      ),
    );
  });

  it("excludes mobile-only changes from desktop update highlights", () => {
    const mobileRecord: ChangeRecord = {
      ...records[0]!,
      evidenceId: "yngatech/t3code#15",
      outcome: "Sync composer drafts on mobile",
      surface: "mobile",
    };
    const sharedRecord: ChangeRecord = {
      ...records[0]!,
      evidenceId: "yngatech/t3code#16",
      outcome: "Sync composer drafts across clients",
      surface: "application",
    };

    assert.deepEqual(filterDesktopUpdateRecords([...records, mobileRecord, sharedRecord]), [
      ...records,
      sharedRecord,
    ]);
  });

  it("normalizes label punctuation and rejects links or multiline output", () => {
    assert.deepEqual(
      parseChangelogSummary(
        '{"added":[{"text":"Play completion sounds.","evidenceIds":["yngatech/t3code#14","yngatech/t3code#14"]}],"improved":[],"removed":[]}',
      ),
      {
        added: [{ text: "Play completion sounds", evidenceIds: ["yngatech/t3code#14"] }],
        improved: [],
        removed: [],
      },
    );
    assert.throws(() =>
      parseChangelogSummary(
        '{"added":[{"text":"Read [this](https://example.com)","evidenceIds":[]}],"improved":[],"removed":[]}',
      ),
    );
    assert.throws(() =>
      parseChangelogSummary(
        '{"added":[],"improved":[{"text":"First line\\nSecond line","evidenceIds":[]}],"removed":[]}',
      ),
    );
    assert.throws(() =>
      parseChangelogSummary('{"added":["Bare string item"],"improved":[],"removed":[]}'),
    );
  });

  it("keeps only evidence references that exist in the collected evidence", () => {
    const summary = restrictSummaryToEvidence(
      {
        added: [
          {
            text: "Play completion sounds",
            evidenceIds: ["yngatech/t3code#14", "yngatech/t3code#999"],
          },
        ],
        improved: [],
        removed: [],
      },
      new Set(["yngatech/t3code#14"]),
    );

    assert.deepEqual(summary.added[0]?.evidenceIds, ["yngatech/t3code#14"]);
  });

  it("renders current fork features around deterministic release details", () => {
    const rendered = renderForkFeaturesSummary({
      ahead: 35,
      behind: 1,
      forkRef: "a".repeat(40),
      forkRepository: "yngatech/t3code",
      generatedAt: new Date("2026-08-08T12:00:00Z"),
      model: "gpt-5.6-sol",
      summary: {
        added: [
          { text: "Play configurable completion sounds", evidenceIds: ["yngatech/t3code#14"] },
        ],
        improved: [{ text: "Show exit codes for shell commands", evidenceIds: [] }],
        removed: [{ text: "Remove a superseded internal feature", evidenceIds: [] }],
      },
      upstreamRef: "b".repeat(40),
      upstreamRepository: "pingdotgg/t3code",
    });

    assert.match(rendered, /35 commits ahead/);
    assert.match(rendered, /1 commit behind/);
    assert.equal(/1 commits behind/.test(rendered), false);
    assert.match(
      rendered,
      /## Added\n\n- Play configurable completion sounds \(\[#14\]\(https:\/\/github\.com\/yngatech\/t3code\/pull\/14\)\)/,
    );
    assert.match(rendered, /## Improved\n\n- Show exit codes for shell commands/);
    assert.equal(/superseded internal feature/.test(rendered), false);
  });

  it("renders nightly highlights as a flat tooltip-safe list with PR references", () => {
    const rendered = renderNightlySummary(
      {
        added: [{ text: "Start threads from GitHub issues", evidenceIds: ["yngatech/t3code#14"] }],
        improved: [
          {
            text: "Show setup script outcomes in the thread timeline",
            evidenceIds: ["pingdotgg/t3code#12083", `pingdotgg/t3code@${"c".repeat(12)}`],
          },
        ],
        removed: [{ text: "Remove the superseded status preview", evidenceIds: [] }],
      },
      "yngatech/t3code",
    );

    assert.equal(
      rendered,
      "- Start threads from GitHub issues ([#14](https://github.com/yngatech/t3code/pull/14))\n" +
        "- Show setup script outcomes in the thread timeline " +
        "([t3code#12083](https://github.com/pingdotgg/t3code/pull/12083), " +
        `[\`${"c".repeat(7)}\`](https://github.com/pingdotgg/t3code/commit/${"c".repeat(12)}))\n` +
        "- Remove the superseded status preview\n",
    );
    assert.equal(/^#|\n#/.test(rendered), false);
    assert.equal(
      renderNightlySummary({ added: [], improved: [], removed: [] }, "yngatech/t3code"),
      "",
    );
  });
});
