// @effect-diagnostics globalDate:off - Fixed native dates keep rendered release metadata deterministic.
import { assert, describe, it } from "@effect/vitest";
import {
  buildChangeExtractionPrompt,
  cachedCapabilities,
  cachedChangeRecords,
  chunkEvidenceForExtraction,
  collectChangeEvidence,
  extractInBatches,
  extractionCacheKeys,
  extractResponseText,
  filterDesktopUpdateRecords,
  filterForkFeatureRecords,
  fitEvidenceToPromptBudget,
  mergeExtractionCache,
  parseChangeRecords,
  parseChangelogSummary,
  parseExtractionCache,
  parsePullRequestNumber,
  planExtraction,
  renderForkFeaturesSummary,
  renderNightlySummary,
  restrictSummaryToEvidence,
  sanitizePullRequestBody,
  serializeExtractionCache,
  type ChangeEvidence,
  type ChangeRecord,
  type ExtractionCache,
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
    patchId: "1".repeat(40),
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
    identity: false,
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
      { ...evidence[0]!, id: "yngatech/t3code#21", diff: "x".repeat(300_000) },
    ];

    const fitted = fitEvidenceToPromptBudget(oversized);

    assert.equal(fitted[0]?.diff, "small diff");
    assert.equal(fitted[1]?.diff, "");
    assert.deepEqual(fitEvidenceToPromptBudget(evidence), evidence);
  });

  it("splits evidence into chronological batches that fit the prompt budget", () => {
    const many = Array.from({ length: 45 }, (_, index) => ({
      ...evidence[0]!,
      id: `yngatech/t3code#${index + 100}`,
    }));

    const batches = chunkEvidenceForExtraction(many);

    assert.deepEqual(
      batches.map((batch) => batch.length),
      [20, 20, 5],
    );
    assert.deepEqual(
      batches.flatMap((batch) => batch.map((item) => item.id)),
      many.map((item) => item.id),
    );
    for (const batch of batches) {
      assert.equal(JSON.stringify(batch, null, 2).length <= 240_000, true);
    }
  });

  it("keeps evidence larger than the whole budget in a batch of its own", () => {
    const batches = chunkEvidenceForExtraction([
      evidence[0]!,
      { ...evidence[0]!, id: "yngatech/t3code#21", diff: "x".repeat(300_000) },
      { ...evidence[0]!, id: "yngatech/t3code#22" },
    ]);

    assert.deepEqual(
      batches.map((batch) => batch.map((item) => item.id)),
      [["yngatech/t3code#14"], ["yngatech/t3code#21"], ["yngatech/t3code#22"]],
    );
    assert.deepEqual(chunkEvidenceForExtraction([]), []);
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

  it("keeps identity changes in a release but out of the fork features summary", () => {
    const brandingRecord: ChangeRecord = {
      ...records[0]!,
      evidenceId: "yngatech/t3code#3",
      capability: "Application branding",
      outcome: "Show the fork's own application name and icon",
      identity: true,
    };

    assert.deepEqual(filterForkFeatureRecords([...records, brandingRecord]), [...records]);
    assert.deepEqual(filterDesktopUpdateRecords([...records, brandingRecord]), [
      ...records,
      brandingRecord,
    ]);
  });

  it("rejects a change record without an identity flag", () => {
    const { identity: _identity, ...withoutIdentity } = records[0]!;

    assert.throws(() => parseChangeRecords(JSON.stringify({ changes: [withoutIdentity] })));
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

describe("extraction cache", () => {
  const patchIds = new Map([["yngatech/t3code#14", "1".repeat(40)]]);
  const keys = extractionCacheKeys(evidence, patchIds, "gpt-5.6-sol");
  const cache: ExtractionCache = new Map([
    ["yngatech/t3code#14", { key: keys.get("yngatech/t3code#14")!, records }],
  ]);

  it("keys entries on the patch id so the nightly rebase does not invalidate the stack", () => {
    const rebased = extractionCacheKeys(
      [{ ...evidence[0]!, sha: "d".repeat(40), diff: "@@ -41,1 +41,1 @@\n+ moved context" }],
      patchIds,
      "gpt-5.6-sol",
    );

    assert.equal(rebased.get("yngatech/t3code#14"), keys.get("yngatech/t3code#14"));
  });

  it("invalidates entries when the pull request content or the model changes", () => {
    const editedDescription = extractionCacheKeys(
      [{ ...evidence[0]!, description: "A rewritten description." }],
      patchIds,
      "gpt-5.6-sol",
    );
    const editedTitle = extractionCacheKeys(
      [{ ...evidence[0]!, title: "feat(web): rename the outage notice" }],
      patchIds,
      "gpt-5.6-sol",
    );
    const movedFiles = extractionCacheKeys(
      [{ ...evidence[0]!, files: ["apps/web/src/components/sidebar/StatusNotice.tsx"] }],
      patchIds,
      "gpt-5.6-sol",
    );
    const amendedPatch = extractionCacheKeys(
      evidence,
      new Map([["yngatech/t3code#14", "2".repeat(40)]]),
      "gpt-5.6-sol",
    );
    const otherModel = extractionCacheKeys(evidence, patchIds, "gpt-5.6-mini");

    for (const changed of [
      editedDescription,
      editedTitle,
      movedFiles,
      amendedPatch,
      otherModel,
    ]) {
      assert.notEqual(changed.get("yngatech/t3code#14"), keys.get("yngatech/t3code#14"));
    }
  });

  it("extracts only evidence the cache does not already answer", () => {
    const added: ChangeEvidence = { ...evidence[0]!, id: "yngatech/t3code#15" };
    const withAdded = [...evidence, added];
    const plan = planExtraction(
      withAdded,
      extractionCacheKeys(withAdded, patchIds, "gpt-5.6-sol"),
      cache,
    );

    assert.deepEqual(plan.pending, [added]);
    assert.deepEqual(cachedChangeRecords(plan.cached), records);
    assert.deepEqual(cachedCapabilities(plan.cached), ["GitHub outage status"]);
  });

  it("carries cached capability names into the batched extraction prompt", () => {
    const prompt = buildChangeExtractionPrompt(evidence, ["GitHub outage status"]);

    assert.match(prompt, /reuse one verbatim/);
    assert.match(prompt, /"GitHub outage status"/);
    assert.equal(/reuse one verbatim/.test(buildChangeExtractionPrompt(evidence)), false);
  });

  it("caches evidence that produced no records so it is never re-extracted", () => {
    const docsOnly: ChangeEvidence = { ...evidence[0]!, id: "yngatech/t3code#16" };
    const plan = { cached: cache, pending: [docsOnly] };
    const merged = mergeExtractionCache(
      plan,
      extractionCacheKeys([...evidence, docsOnly], patchIds, "gpt-5.6-sol"),
      [],
    );

    assert.deepEqual(merged.get("yngatech/t3code#16")?.records, []);
    assert.deepEqual(cachedChangeRecords(merged), records);
  });

  it("leaves evidence read without its diff uncached so a smaller batch re-reads it", () => {
    const clipped: ChangeEvidence = { ...evidence[0]!, id: "yngatech/t3code#17" };
    const clippedRecord: ChangeRecord = { ...records[0]!, evidenceId: "yngatech/t3code#17" };
    const merged = mergeExtractionCache(
      { cached: cache, pending: [clipped] },
      extractionCacheKeys([...evidence, clipped], patchIds, "gpt-5.6-sol"),
      [clippedRecord],
      new Set(["yngatech/t3code#17"]),
    );

    assert.equal(merged.has("yngatech/t3code#17"), false);
    assert.deepEqual([...merged.keys()], ["yngatech/t3code#14"]);
  });

  it("drops evidence that left the release and rejects records outside the batch", () => {
    const added: ChangeEvidence = { ...evidence[0]!, id: "yngatech/t3code#15" };
    const freshRecord: ChangeRecord = { ...records[0]!, evidenceId: "yngatech/t3code#15" };
    const merged = mergeExtractionCache(
      { cached: new Map(), pending: [added] },
      extractionCacheKeys([added], patchIds, "gpt-5.6-sol"),
      [freshRecord],
    );

    assert.deepEqual([...merged.keys()], ["yngatech/t3code#15"]);
    assert.throws(() =>
      mergeExtractionCache(
        { cached: cache, pending: [added] },
        extractionCacheKeys([...evidence, added], patchIds, "gpt-5.6-sol"),
        [records[0]!],
      ),
    );
  });

  it("carries capability names forward across batches and hands over each batch's cache", async () => {
    const many = Array.from({ length: 45 }, (_, index) => ({
      ...evidence[0]!,
      id: `yngatech/t3code#${index + 100}`,
    }));
    const manyKeys = extractionCacheKeys(many, new Map(), "gpt-5.6-sol");
    const hints: Array<ReadonlyArray<string>> = [];
    const handovers: Array<number> = [];

    const extraction = await extractInBatches(
      { cached: new Map(), pending: many },
      manyKeys,
      async (batch, knownCapabilities) => {
        hints.push(knownCapabilities);
        return batch.map((item) => ({ ...records[0]!, evidenceId: item.id, capability: item.id }));
      },
      (cache) => handovers.push(cache.size),
    );

    assert.deepEqual(
      hints.map((names) => names.length),
      [0, 20, 40],
    );
    assert.deepEqual(hints[1], many.slice(0, 20).map((item) => item.id).sort());
    assert.deepEqual(handovers, [20, 40, 45]);
    assert.equal(extraction.records.length, 45);
    assert.equal(extraction.cache.size, 45);
  });

  it("stops feeding a batch's cache forward when its extraction fails", async () => {
    const many = Array.from({ length: 45 }, (_, index) => ({
      ...evidence[0]!,
      id: `yngatech/t3code#${index + 100}`,
    }));
    const manyKeys = extractionCacheKeys(many, new Map(), "gpt-5.6-sol");
    const handovers: Array<ExtractionCache> = [];
    let calls = 0;

    let failure: unknown;
    try {
      await extractInBatches(
        { cached: new Map(), pending: many },
        manyKeys,
        async (batch) => {
          calls += 1;
          if (calls === 2) throw new Error("stubbed extraction failure");
          return batch.map((item) => ({ ...records[0]!, evidenceId: item.id }));
        },
        (cache) => handovers.push(cache),
      );
    } catch (caught) {
      failure = caught;
    }

    assert.instanceOf(failure, Error);
    assert.equal(handovers.length, 1);
    assert.equal(handovers[0]?.size, 20);
  });

  it("round-trips through the cache file and rejects a foreign shape", () => {
    assert.deepEqual(parseExtractionCache(serializeExtractionCache(cache)), cache);
    assert.throws(() => parseExtractionCache(JSON.stringify({ version: 0, entries: {} })));
    assert.throws(() =>
      parseExtractionCache(
        JSON.stringify({ version: 1, entries: { "yngatech/t3code#14": { key: "abc" } } }),
      ),
    );
  });
});
