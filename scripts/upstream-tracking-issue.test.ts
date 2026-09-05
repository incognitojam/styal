import { assert, describe, it } from "@effect/vitest";

import {
  appendUnlisted,
  areasForPaths,
  catchupSinceIso,
  effectiveScanBoundary,
  fitTrackingIssueBody,
  landedUpstreamPullRequests,
  listedNumbers,
  prepareTrackingIssueUpdate,
  pruneTrackingEntries,
  reconcilePromoted,
  refreshTrackingIntro,
  renderPullRequestLine,
  terminalStateNumbers,
  upstreamPageReachesWindowBoundary,
  validateTrackingRepository,
  writeCatchupSince,
  writeTerminalState,
  writeTrackingState,
} from "./upstream-tracking-issue.ts";
import { parseSourcePullRequestInput, parseUpstreamProvenance } from "./upstream-provenance.ts";

const pullRequest = (number: number, mergedAt: string, title = `fix(web): change ${number}`) => ({
  number,
  title,
  mergedAt,
  areas: ["apps/web"],
});

describe("upstream tracking issue", () => {
  it("appends only pull requests the issue does not already list, oldest first", () => {
    const body = [
      "- [x] `#100` 2026-08-01 · `fix(web): old` · apps/web",
      "  take, but keep our sidebar clustering",
      "",
    ].join("\n");
    const { body: next, added } = appendUnlisted(body, [
      pullRequest(102, "2026-08-03T10:00:00Z"),
      pullRequest(99, "2026-07-31T10:00:00Z"),
      pullRequest(100, "2026-08-01T10:00:00Z"),
      pullRequest(101, "2026-08-02T10:00:00Z"),
    ]);

    assert.deepEqual(
      added.map((p) => p.number),
      [99, 101, 102],
    );
    assert.include(next, "- [x] `#100` 2026-08-01");
    assert.include(next, "  take, but keep our sidebar clustering");
    assert.isTrue(next.indexOf("`#99`") < next.indexOf("`#100`"));
    assert.isTrue(next.indexOf("`#101`") < next.indexOf("`#102`"));
  });

  it("leaves the body untouched when nothing is new", () => {
    const body = "- [ ] `#7` 2026-08-01 · `x` · apps/web\n";
    const result = appendUnlisted(body, [pullRequest(7, "2026-08-01T00:00:00Z")]);
    assert.strictEqual(result.body, body);
    assert.deepEqual(result.added, []);
  });

  it("seeds an empty issue with the intro", () => {
    const { body } = appendUnlisted("", [pullRequest(1, "2026-08-01T00:00:00Z")]);
    assert.include(body, "Upstream pull requests in the rolling intake window");
    assert.include(body, "- [ ] `#1`");
  });

  it("never renders anything that links to or mentions upstream", () => {
    const line = renderPullRequestLine({
      number: 8694,
      title: "fix(mobile): thanks @someone, see `#8600` and https://example.com",
      mergedAt: "2026-08-29T12:00:00Z",
      areas: ["apps/mobile"],
    });

    assert.notInclude(line, "github.com");
    assert.notInclude(line, "pingdotgg");
    // The title sits inside one backtick span, so the @-mention and #-ref
    // inside it cannot autolink; its own backticks are neutralised first.
    assert.match(line, /^- \[ \] `#8694` 2026-08-29 · `[^`]*` · `apps\/mobile`$/);
  });

  it("collapses title whitespace so issue markup cannot be injected", () => {
    const line = renderPullRequestLine({
      number: 9,
      title: "fix(web): safe\n- [ ] `#10` injected",
      mergedAt: "2026-08-29T00:00:00Z",
      areas: ["apps/web"],
    });

    assert.notInclude(line, "\n");
    assert.match(line, /^- \[ \] `#9` [^\n]+$/u);
  });

  it("keeps scoped package paths from reading as mentions", () => {
    const line = renderPullRequestLine({
      number: 1,
      title: "chore: bump",
      mergedAt: "2026-08-29T00:00:00Z",
      areas: ["patches/@expo__metro-config@57.0.12.patch", "apps/`mobile\n@someone"],
    });
    // Every `@` sits inside a code span, so nothing can autolink as a user.
    assert.notMatch(line.replaceAll(/`[^`]*`/g, ""), /@/);
    assert.notInclude(line, "\n");
  });

  it("reads tracked numbers from issue entries rather than references in notes", () => {
    const body = [
      "- [ ] `#5` 2026-08-01 · `tracked`",
      "  compare with `#6`",
      "- [x] `#7` 2026-08-02 · `queued`",
    ].join("\n");

    assert.deepEqual([...listedNumbers(body)], [5, 7]);
  });

  it("round-trips compact terminal state without exposing active references", () => {
    const body = writeTerminalState("intro\n- [ ] `#5` 2026-08-01 · `open`\n", new Set([9, 7]));

    assert.deepEqual([...terminalStateNumbers(body)], [7, 9]);
    assert.include(body, "<!-- upstream-tracking-terminal:7,9 -->");
    assert.notInclude(body, "`#7`");
    assert.throws(
      () => terminalStateNumbers("<!-- upstream-tracking-terminal:7,nope -->"),
      "malformed",
    );
  });

  it("round-trips the fixed catch-up boundary while candidates are deferred", () => {
    const since = "2026-08-22T07:00:00.000Z";
    const body = writeCatchupSince("intro\n", since);

    assert.strictEqual(catchupSinceIso(body), since);
    assert.strictEqual(effectiveScanBoundary(body, "2026-08-29T07:00:00.000Z"), since);
    assert.strictEqual(
      effectiveScanBoundary(body, "2026-08-15T07:00:00.000Z"),
      "2026-08-15T07:00:00.000Z",
    );
    assert.strictEqual(catchupSinceIso(writeCatchupSince(body)), undefined);
    assert.throws(
      () => catchupSinceIso("<!-- upstream-tracking-catchup-since:not-a-date -->"),
      "malformed",
    );
  });

  it("rewrites both hidden markers without accumulating blank lines", () => {
    const since = "2026-08-22T07:00:00.000Z";
    const expected = `intro

<!-- upstream-tracking-terminal:7,9 -->
<!-- upstream-tracking-catchup-since:${since} -->
`;
    let body = "intro\n";
    for (let run = 0; run < 4; run += 1) {
      body = writeCatchupSince(body, since);
      body = writeTerminalState(body, new Set([9, 7]));
      assert.strictEqual(body, expected);
    }

    assert.strictEqual(
      writeTrackingState(body, { terminal: new Set([7, 9]) }),
      "intro\n\n<!-- upstream-tracking-terminal:7,9 -->\n",
    );
  });

  it("collapses touched paths to their top two segments", () => {
    assert.deepEqual(
      areasForPaths([
        "apps/web/src/a.ts",
        "apps/web/src/b.ts",
        "packages/shared/x.ts",
        "AGENTS.md",
      ]),
      ["AGENTS.md", "apps/web", "packages/shared"],
    );
  });

  it("refreshes only the known legacy introduction", () => {
    const legacy = `Upstream pull requests not yet on \`main\`, newest last. Tick a box and add direction
beneath it, then dispatch an agent with the ticked items. The list is appended by
\`upstream-tracking.yml\`; edits here are preserved.

- [ ] \`#1\` 2026-08-01 · \`x\``;

    const refreshed = refreshTrackingIntro(legacy);

    assert.include(refreshed, "rolling intake window");
    assert.include(refreshed, "- [ ] `#1`");
    assert.strictEqual(refreshTrackingIntro("custom intro"), "custom intro");
  });

  it("marks landed entries as promoted without disturbing their notes", () => {
    const body = [
      "- [x] `#100` 2026-08-01 · `fix(web): selected` · `apps/web`",
      "  preserve the fork behavior",
      "- [ ] `#101` 2026-08-02 · `fix(web): open` · `apps/web`",
      "",
    ].join("\n");
    const first = reconcilePromoted(
      body,
      new Map([
        [100, "a".repeat(40)],
        [101, "b".repeat(40)],
      ]),
    );
    const second = reconcilePromoted(first.body, new Map([[100, "c".repeat(40)]]));

    assert.deepEqual(first.reconciled, [100, 101]);
    assert.include(first.body, "- [x] `#100`");
    assert.include(first.body, "— promoted `aaaaaaa`");
    assert.include(first.body, "  preserve the fork behavior");
    assert.strictEqual(second.body, first.body);
    assert.deepEqual(second.reconciled, []);
  });

  it("preserves terminal dispositions while promotion resolves review-needed entries", () => {
    const body = [
      "- [x] `#100` 2026-08-01 · `x` — already present",
      "- [x] `#101` 2026-08-01 · `x` — skip: conflicts with fork behavior",
      "- [ ] `#102` 2026-08-01 · `x` — review needed: contract overlap",
    ].join("\n");
    const result = reconcilePromoted(
      body,
      new Map([
        [100, "a".repeat(40)],
        [101, "b".repeat(40)],
        [102, "c".repeat(40)],
      ]),
    );

    assert.include(result.body, "`#100` 2026-08-01 · `x` — already present");
    assert.include(result.body, "`#101` 2026-08-01 · `x` — skip: conflicts with fork behavior");
    assert.include(result.body, "- [x] `#102` 2026-08-01 · `x` — promoted `ccccccc`");
    assert.notInclude(result.body, "review needed");
    assert.deepEqual(result.reconciled, [102]);
  });

  it("does not mistake disposition words inside a title for state", () => {
    const body = ["skip", "promoted", "review needed"]
      .map(
        (word, index) =>
          `- [ ] \`#${100 + index}\` 2026-08-01 · \`fix(web): do not — ${word} this update\` · \`apps/web\``,
      )
      .join("\n");
    const result = reconcilePromoted(
      body,
      new Map([
        [100, "a".repeat(40)],
        [101, "b".repeat(40)],
        [102, "c".repeat(40)],
      ]),
    );

    assert.deepEqual(result.reconciled, [100, 101, 102]);
    assert.include(result.body, "— promoted `aaaaaaa`");
  });

  it("bounds the feed while retaining explicitly queued and review-needed backlog", () => {
    const body = [
      "intro",
      "",
      "- [x] `#100` 2026-07-01 · `old promoted` — promoted `aaaaaaa`",
      "  old note",
      "",
      "- [x] `#101` 2026-07-01 · `old selected`",
      "- [ ] `#102` 2026-07-01 · `old review` — review needed: decide",
      "- [ ] `#104` 2026-07-01 · `old untouched`",
      "  unqueued note",
      "- [x] `#103` 2026-08-15 · `recent skip` — skip: not for the fork",
      "",
    ].join("\n");
    const result = pruneTrackingEntries(body, "2026-08-01");

    assert.deepEqual(result.prunedTerminal, [100]);
    assert.deepEqual(result.expiredOpen, [104]);
    assert.deepEqual(result.retainedBacklog, [101, 102]);
    assert.notInclude(result.body, "old promoted");
    assert.notInclude(result.body, "old note");
    assert.notInclude(result.body, "old untouched");
    assert.notInclude(result.body, "unqueued note");
    assert.include(result.body, "old selected");
    assert.include(result.body, "old review");
    assert.include(result.body, "recent skip");
  });

  it("preserves a separating blank line after pruning an entry and its notes", () => {
    const body = [
      "- [ ] `#100` 2026-07-01 · `old untouched`",
      "  old note",
      "",
      "## Maintainer footer",
    ].join("\n");
    const result = pruneTrackingEntries(body, "2026-08-01");

    assert.strictEqual(result.body, "\n## Maintainer footer");
  });

  it("compacts resolved and unqueued entries before sacrificing deliberate backlog", () => {
    const body = [
      "intro",
      "",
      `- [x] \`#100\` 2026-08-01 · \`${"resolved".repeat(10)}\` — promoted \`aaaaaaa\``,
      "- [ ] `#101` 2026-08-02 · `oldest open candidate`",
      "  candidate note",
      "",
      "- [x] `#102` 2026-08-03 · `queued backlog`",
      "  preserve this direction",
      "- [ ] `#103` 2026-08-04 · `needs a decision` — review needed: contract overlap",
      "- [ ] `#104` 2026-08-05 · `newer open candidate`",
      "",
    ].join("\n");
    const result = fitTrackingIssueBody(body, 260);

    assert.deepEqual(result.compactedTerminal, [100]);
    assert.deepEqual(result.deferredOpen, [104]);
    assert.strictEqual(result.backlogCount, 2);
    assert.isFalse(result.overflow);
    assert.include(result.body, "candidate note");
    assert.include(result.body, "preserve this direction");
    assert.include(result.body, "needs a decision");
    assert.notInclude(result.body, "newer open candidate");
  });

  it("reports overflow instead of removing checked backlog", () => {
    const body = `- [x] \`#100\` 2026-08-01 · \`${"queued".repeat(20)}\``;
    const result = fitTrackingIssueBody(body, 20);

    assert.isTrue(result.overflow);
    assert.strictEqual(result.body, body);
    assert.strictEqual(result.backlogCount, 1);
  });

  it("pages catch-up from oldest to newest without relisting terminal decisions", () => {
    const candidates = [
      pullRequest(1, "2026-08-01T00:00:00Z", "oldest"),
      pullRequest(2, "2026-08-02T00:00:00Z", "second"),
      pullRequest(3, "2026-08-03T00:00:00Z", "third"),
      pullRequest(4, "2026-08-04T00:00:00Z", "newest"),
    ];
    const first = prepareTrackingIssueUpdate({
      body: "catch-up\n",
      candidates,
      landed: new Map(),
      cutoffDate: "2026-07-01",
      targetLength: 170,
    });

    assert.include(first.body, "`#1`");
    assert.include(first.body, "`#2`");
    assert.notInclude(first.body, "`#4`");
    assert.include(first.fitted.deferredOpen, 4);

    const decided = first.body.replace("`oldest`", "`oldest` — skip: not for the fork");
    const second = prepareTrackingIssueUpdate({
      body: decided,
      candidates,
      landed: new Map(),
      cutoffDate: "2026-07-01",
      targetLength: 170,
    });
    const third = prepareTrackingIssueUpdate({
      body: second.body,
      candidates,
      landed: new Map(),
      cutoffDate: "2026-07-01",
      targetLength: 170,
    });

    assert.notInclude(second.body, "`#1`");
    assert.include(second.body, "`#3`");
    assert.include(terminalStateNumbers(second.body), 1);
    assert.notInclude(third.body, "`#1`");
    assert.notInclude(
      third.appended.added.map((pullRequest) => pullRequest.number),
      1,
    );
  });

  it("derives landed sources from trailers, fork PR bodies, and cherry-pick metadata", () => {
    const result = landedUpstreamPullRequests(
      [
        {
          sha: "a".repeat(40),
          message:
            "fix: combined\n\nSource PRs:\n\n- `pingdotgg/t3code#300`\n\nVerification:\n\n- focused tests\n\nUpstream-PR: 301, 302",
        },
        {
          sha: "b".repeat(40),
          message: `fix: picked\n\n(cherry picked from commit ${"c".repeat(40)})`,
        },
      ],
      new Map([["c".repeat(40), 303]]),
    );

    assert.deepEqual([...result.landed.keys()], [300, 301, 302, 303]);
    assert.strictEqual(result.landed.get(300), "a".repeat(40));
    assert.strictEqual(result.landed.get(303), "b".repeat(40));
    assert.deepEqual(result.errors, []);
  });

  it("parses and validates explicit source provenance", () => {
    assert.deepEqual(parseSourcePullRequestInput("302, 300, 302"), [300, 302]);
    assert.isNull(parseSourcePullRequestInput("300 and 302"));
    assert.isNull(parseSourcePullRequestInput("0"));
    assert.isNull(parseSourcePullRequestInput("999999999999999999999"));

    const parsed = parseUpstreamProvenance([
      "Source PRs:\n\n- `pingdotgg/t3code#302`\n\nupstream-pr: 301, 300",
    ]);
    assert.deepEqual(parsed.pullRequestNumbers, [300, 301, 302]);
    assert.deepEqual(parsed.errors, []);

    const malformed = parseUpstreamProvenance(["Upstream-PR: 300, nope"]);
    assert.deepEqual(malformed.pullRequestNumbers, []);
    assert.lengthOf(malformed.errors, 1);
  });

  it("ignores escaped upstream references outside the explicit source section", () => {
    const parsed = parseUpstreamProvenance([
      "Unlike `pingdotgg/t3code#299`, this keeps the fork behavior.\n\nSource PRs:\n\n- `pingdotgg/t3code#300`\n\nNotes:\n\n- `pingdotgg/t3code#301`",
    ]);

    assert.deepEqual(parsed.pullRequestNumbers, [300]);
  });

  it("stops updated-at pagination once a page crosses the scan boundary", () => {
    assert.isFalse(
      upstreamPageReachesWindowBoundary(
        [{ updatedAt: "2026-09-05T12:00:00Z" }, { updatedAt: "2026-09-05T10:00:00Z" }],
        "2026-09-05T09:00:00Z",
      ),
    );
    assert.isTrue(
      upstreamPageReachesWindowBoundary(
        [{ updatedAt: "2026-09-05T10:00:00Z" }, { updatedAt: "2026-09-05T08:00:00Z" }],
        "2026-09-05T09:00:00Z",
      ),
    );
    assert.isTrue(upstreamPageReachesWindowBoundary([], "2026-09-05T09:00:00Z"));
  });

  it("refuses to edit an issue in the upstream repository", () => {
    assert.throws(
      () => validateTrackingRepository("pingdotgg/t3code", "pingdotgg/t3code"),
      "must belong to the fork",
    );
    assert.doesNotThrow(() => validateTrackingRepository("incognitojam/styal", "pingdotgg/t3code"));
  });
});
