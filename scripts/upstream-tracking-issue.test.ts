import { assert, describe, it } from "@effect/vitest";

import {
  appendUnlisted,
  areasForPaths,
  listedNumbers,
  renderPullRequestLine,
} from "./upstream-tracking-issue.ts";

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
      pullRequest(100, "2026-08-01T10:00:00Z"),
      pullRequest(101, "2026-08-02T10:00:00Z"),
    ]);

    assert.deepEqual(
      added.map((p) => p.number),
      [101, 102],
    );
    assert.include(next, "- [x] `#100` 2026-08-01");
    assert.include(next, "  take, but keep our sidebar clustering");
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
    assert.include(body, "Upstream pull requests not yet on `main`");
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

  it("keeps scoped package paths from reading as mentions", () => {
    const line = renderPullRequestLine({
      number: 1,
      title: "chore: bump",
      mergedAt: "2026-08-29T00:00:00Z",
      areas: ["patches/@expo__metro-config@57.0.12.patch", "apps/mobile"],
    });
    // Every `@` sits inside a code span, so nothing can autolink as a user.
    assert.notMatch(line.replaceAll(/`[^`]*`/g, ""), /@/);
  });

  it("reads tracked numbers from backticked references only", () => {
    assert.deepEqual([...listedNumbers("`#5` and #6 and `#7`")], [5, 7]);
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
});
