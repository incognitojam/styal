import { describe, expect, it } from "vite-plus/test";

import { GitHubActionsLogFormatter } from "./terminalOutputPresentation";

const ANSI_ESCAPE = new RegExp(`${"\u001b"}\\[[0-?]*[ -/]*[@-~]`, "gu");
const plain = (value: string) => value.replace(ANSI_ESCAPE, "");
const COMMAND = "gh api repos/acme/widgets/actions/jobs/34/logs";

/** Renders one live snapshot at a fixed clock, the way the polling loop emits it. */
function snapshot(now: string, ...lines: string[]): string {
  const formatter = new GitHubActionsLogFormatter(COMMAND, () => Date.parse(now));
  const input = ["::T3S::", ...lines, "::T3E::", ""].join("\n");
  return formatter.write(input);
}

describe("GitHubActionsLogFormatter", () => {
  it("turns Actions groups into a compact visual hierarchy", () => {
    const formatter = new GitHubActionsLogFormatter(COMMAND);
    const formatted = formatter.write(
      [
        "2026-08-12T12:34:56.100Z ##[group]Install dependencies",
        "2026-08-12T12:34:56.200Z ##[command]vp install",
        "2026-08-12T12:34:56.300Z [command]/usr/bin/git version",
        "2026-08-12T12:34:57.000Z Resolved 43 packages",
        "2026-08-12T12:34:58.000Z ##[endgroup]",
        "",
      ].join("\n"),
    );

    expect(plain(formatted)).toBe(
      [
        "12:34:56  ┌─ Install dependencies",
        "12:34:56  │ ❯ vp install",
        "12:34:56  │ ❯ /usr/bin/git version",
        "12:34:57  │ Resolved 43 packages",
        "12:34:58  └─",
        "",
      ].join("\n"),
    );
  });

  it("gives workflow annotations distinct symbols", () => {
    const formatter = new GitHubActionsLogFormatter(COMMAND);
    const formatted = formatter.write(
      [
        "2026-08-12T12:34:56Z ##[warning]Cache miss",
        "2026-08-12T12:34:57Z ##[error]Tests failed",
        "2026-08-12T12:34:58Z ::notice title=Summary::43 tests passed",
        "",
      ].join("\n"),
    );

    expect(plain(formatted)).toBe(
      [
        "12:34:56  ▲ Cache miss",
        "12:34:57  ✕ Tests failed",
        "12:34:58  ● 43 tests passed",
        "",
      ].join("\n"),
    );
  });

  it("formats a timestamped line split across terminal chunks", () => {
    const formatter = new GitHubActionsLogFormatter(COMMAND);

    expect(plain(formatter.write("2026-08-12T12:34:56Z ##[gro"))).toBe("");
    expect(plain(formatter.write("up]Build\r\n"))).toBe("12:34:56  ┌─ Build\r\n");
  });

  it("hides shell framing but preserves status, failures, and embedded job colors", () => {
    const formatter = new GitHubActionsLogFormatter(COMMAND);

    expect(plain(formatter.write(`workspace % ${COMMAND}\r\n`))).toBe("");
    expect(plain(formatter.write("Refreshing run status every 3 seconds.\r\n"))).toBe(
      "Refreshing run status every 3 seconds.\r\n",
    );
    expect(plain(formatter.write("gh: HTTP 401\r\n"))).toBe("gh: HTTP 401\r\n");
    expect(formatter.write("2026-08-12T12:34:56Z \x1b[32mTests passed\x1b[0m\n")).toContain(
      "\x1b[32mTests passed\x1b[0m",
    );
    expect(plain(formatter.write("workspace %\r\n"))).toBe("");
    expect(plain(formatter.write("workspace %"))).toBe("");
  });

  it("reset discards incomplete input and group nesting", () => {
    const formatter = new GitHubActionsLogFormatter(COMMAND);
    formatter.write("2026-08-12T12:34:56Z ##[group]Build\n");
    formatter.write("2026-08-12T12:34:57Z partial");

    formatter.reset();

    expect(plain(formatter.write("shell ready\n"))).toBe("shell ready\n");
    expect(plain(formatter.write("2026-08-12T12:34:58Z fresh\n"))).toBe("12:34:58    fresh\n");
  });

  it("marks the running step and aligns each step's measure", () => {
    const formatted = snapshot(
      "2026-08-12T12:35:00Z",
      "::T3J::\tin_progress\t\t2026-08-12T12:34:00Z\t",
      "::T3P::\tcompleted\tsuccess\tSet up job\t2026-08-12T12:34:00Z\t2026-08-12T12:34:02Z",
      "::T3P::\tin_progress\t\tRun 43 tests\t2026-08-12T12:34:30Z\t",
      "::T3P::\tqueued\t\tPublish\t\t",
    );

    expect(plain(formatted)).toContain("● Running · step 2 of 3 · 1m");
    expect(plain(formatted)).toContain("  ✓  Set up job     2s");
    // Only the running step carries the edge bar, and only it is bold.
    expect(plain(formatted)).toContain("▌ ●  Run 43 tests  30s");
    expect(formatted).toContain("\x1b[1mRun 43 tests");
    // A step that has not started has no measure to align against.
    expect(plain(formatted)).toContain("  ○  Publish");
    expect(plain(formatted)).toContain("Full log opens here when the job finishes");
  });

  it("keeps a queued job with no steps honest about what it is waiting for", () => {
    const formatted = snapshot("2026-08-12T12:35:00Z", "::T3J::\tqueued\t\t\t");

    expect(plain(formatted)).toContain("○ Queued · waiting for a runner");
    expect(plain(formatted)).toContain("Steps appear here as the runner picks them up.");
  });

  it("makes the failed step unmistakable and counts skipped steps below the list", () => {
    const formatted = snapshot(
      "2026-08-12T12:35:00Z",
      "::T3J::\tcompleted\tfailure\t2026-08-12T12:34:00Z\t2026-08-12T12:34:25Z",
      "::T3P::\tcompleted\tsuccess\tSet up job\t2026-08-12T12:34:00Z\t2026-08-12T12:34:02Z",
      "::T3P::\tcompleted\tskipped\tLint\t\t",
      "::T3P::\tcompleted\tfailure\tRun 43 tests\t2026-08-12T12:34:02Z\t2026-08-12T12:34:25Z",
    );

    expect(plain(formatted)).toContain("✕ Failed · 25s");
    expect(plain(formatted)).toContain("▌ ✕  Run 43 tests  23s");
    expect(plain(formatted)).toContain("  ·  1 step skipped");
    expect(plain(formatted)).not.toContain("Lint");
    expect(plain(formatted)).toContain("Opening the full log…");
  });

  it("keeps the running step on screen when a job has more steps than fit", () => {
    const longJob = (activeIndex: number) =>
      snapshot(
        "2026-08-12T12:35:00Z",
        "::T3J::\tin_progress\t\t2026-08-12T12:34:00Z\t",
        ...Array.from({ length: 18 }, (_value, index) => {
          const name = `Task ${String(index + 1).padStart(2, "0")}`;
          if (index < activeIndex) {
            return `::T3P::\tcompleted\tsuccess\t${name}\t2026-08-12T12:34:00Z\t2026-08-12T12:34:01Z`;
          }
          if (index === activeIndex) {
            return `::T3P::\tin_progress\t\t${name}\t2026-08-12T12:34:55Z\t`;
          }
          return `::T3P::\tqueued\t\t${name}\t\t`;
        }),
      );

    const late = plain(longJob(14));
    expect(late).toContain("● Running · step 15 of 18 · 1m");
    expect(late).toContain("  ·  6 earlier steps");
    expect(late).not.toContain("Task 01");
    expect(late).toContain("Task 07");
    expect(late).toContain("▌ ●  Task 15");
    expect(late).toContain("Task 18");

    const early = plain(longJob(3));
    expect(early).toContain("Task 01");
    expect(early).toContain("▌ ●  Task 04");
    expect(early).toContain("  ·  6 later steps");
    expect(early).not.toContain("Task 18");
  });

  it("truncates a long step name instead of wrapping the row", () => {
    const formatted = snapshot(
      "2026-08-12T12:35:00Z",
      "::T3J::\tin_progress\t\t2026-08-12T12:34:00Z\t",
      "::T3P::\tin_progress\t\tRun the entire integration suite against staging\t2026-08-12T12:34:30Z\t",
    );

    expect(plain(formatted)).toContain("▌ ●  Run the entire integration suite…   30s");
  });

  it("replaces the live status view when the raw log begins", () => {
    const formatter = new GitHubActionsLogFormatter(COMMAND);
    const formatted = formatter.write(
      ["::T3L::", "2026-08-12T12:34:56Z ##[group]Build", "2026-08-12T12:34:57Z Complete", ""].join(
        "\n",
      ),
    );

    expect(formatted).toContain("\x1b[2J\x1b[3J\x1b[H");
    expect(plain(formatted)).toContain("12:34:56  ┌─ Build");
    expect(plain(formatted)).toContain("12:34:57  │ Complete");
  });

  it("clears a failed log download before retrying the real log", () => {
    const formatter = new GitHubActionsLogFormatter(COMMAND);
    const formatted = formatter.write(
      [
        "::T3L::",
        "HTTP 404: the log is not ready",
        "::T3L::",
        "2026-08-12T12:34:57Z Complete",
        "",
      ].join("\n"),
    );

    expect(formatted.match(/\x1b\[2J\x1b\[3J\x1b\[H/gu)).toHaveLength(2);
    expect(plain(formatted)).toContain("12:34:57    Complete");
  });
});
