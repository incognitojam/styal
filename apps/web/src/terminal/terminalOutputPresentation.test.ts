import { describe, expect, it } from "vite-plus/test";

import { GitHubActionsLogFormatter } from "./terminalOutputPresentation";

const ANSI_ESCAPE = new RegExp(`${"\u001b"}\\[[0-?]*[ -/]*[@-~]`, "gu");
const plain = (value: string) => value.replace(ANSI_ESCAPE, "");
const COMMAND = "gh api repos/acme/widgets/actions/jobs/34/logs";

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
});
