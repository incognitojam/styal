import { describe, expect, it } from "vite-plus/test";

import { findUpstreamNames, renameTestStrings, renameUpstreamNames } from "./upstream-naming.ts";

const names = (path: string, source: string) =>
  findUpstreamNames(path, source).map(({ line, name }) => `${line}:${name}`);

describe("findUpstreamNames", () => {
  it("finds upstream names in strings, templates and JSX text", () => {
    const source = [
      'const plain = "Link this environment to T3 Connect first.";',
      "const template = `Pi is disabled in ${place} T3 Code settings.`;",
      "const url = 'https://t3.codes/privacy-policy';",
      "const view = <p>Sign in to T3 Connect</p>;",
    ].join("\n");
    expect(names("apps/web/src/example.tsx", source)).toEqual([
      "1:T3 Connect",
      "2:T3 Code",
      "3:t3.codes",
      "4:T3 Connect",
    ]);
  });

  it("finds bare T3 used as a name", () => {
    const source = [
      'const a = "T3 could not ask for approval here.";',
      "const b = `Install Muse Code on this T3 server host.`;",
      'const c = "Set up this Linux host for T3\'s browser.";',
      'const d = "Delegate to a T3-owned child agent.";',
      'const e = "New, nonexistent T3 home to populate.";',
    ].join("\n");
    expect(names("apps/web/src/example.ts", source)).toEqual([
      "1:T3",
      "2:T3",
      "3:T3",
      "4:T3",
      "5:T3",
    ]);
  });

  it("allows other T3 products, the company and T3 header names", () => {
    const source = [
      'const theme = "T3 Chat";',
      'const maintainer = "T3 Tools Inc.";',
      'const stack = "Created with the T3 Stack";',
      'const header = "T3-Mode-Limit must be <runtimeMode>/<interactionMode>.";',
    ].join("\n");
    expect(names("apps/server/src/example.ts", source)).toEqual([]);
  });

  it("ignores comments, identifiers and other spellings", () => {
    const source = [
      "// T3 Code keeps this for upstream compatibility.",
      "/** Reached through T3 Connect. */",
      'const T3Code = "t3code";',
      'const tool = "t3_thread_read";',
      'const env = "T3CODE_HOME";',
    ].join("\n");
    expect(names("apps/server/src/example.ts", source)).toEqual([]);
  });

  it("finds upstream names in native string literals but not comments", () => {
    const source = [
      "// Mirrors T3 Code's notification channel.",
      'val title = "Open T3 Code to continue"',
    ].join("\n");
    expect(names("apps/mobile/modules/example/Example.kt", source)).toEqual(["2:T3 Code"]);
  });
});

describe("renameUpstreamNames", () => {
  it("renames names in string text and leaves code, comments and t3.codes alone", () => {
    const source = [
      "// T3 Code keeps this comment.",
      'const a = "Link this environment to T3 Connect first.";',
      'const b = `Restart the T3 server on ${host("T3 Code")}, then retry T3\'s browser.`;',
      'const c = <p>Open T3 Code {"\\"T3 Connect\\""}</p>;',
      "const T3Code = 'https://t3.codes/privacy-policy';",
    ].join("\n");
    const { text, renames } = renameUpstreamNames("apps/web/src/example.tsx", source);
    expect(text).toBe(
      [
        "// T3 Code keeps this comment.",
        'const a = "Link this environment to styal Link first.";',
        'const b = `Restart the styal server on ${host("styal")}, then retry styal\'s browser.`;',
        'const c = <p>Open styal {"\\"styal Link\\""}</p>;',
        "const T3Code = 'https://t3.codes/privacy-policy';",
      ].join("\n"),
    );
    expect(renames.map(({ line }) => line)).toEqual([2, 3, 3, 3, 4, 4]);
  });

  it("renames native string literals", () => {
    const { text } = renameUpstreamNames(
      "apps/mobile/modules/example/Example.swift",
      'NSLog("T3 video audio session: %@", error)',
    );
    expect(text).toBe('NSLog("styal video audio session: %@", error)');
  });
});

describe("renameTestStrings", () => {
  it("renames assertions that quote a renamed string and keeps short test data", () => {
    const source = [
      'expect(message).toContain("this T3 server host");',
      'expect(message).toBe("Pi is disabled in T3 Code settings.");',
      'const project = makeProject({ title: "T3 Code" });',
    ].join("\n");
    const { text } = renameTestStrings("packages/example/src/example.test.ts", source, [
      "Install Muse Code and run `muse login` on this T3 server host.",
      "Pi is disabled in T3 Code settings.",
    ]);
    expect(text).toBe(
      [
        'expect(message).toContain("this styal server host");',
        'expect(message).toBe("Pi is disabled in styal settings.");',
        'const project = makeProject({ title: "T3 Code" });',
      ].join("\n"),
    );
  });
});

describe("renameUpstreamNames identity strings", () => {
  it("leaves compared, keyed, identity-property and channel-name strings for a person", () => {
    const source = [
      'if (name === "T3 Code (Alpha)") return;',
      'const keys = { keychainService: "T3 Code (Beta) Safe Storage", label: "T3 Connect" };',
      'switch (hop) { case "T3 Connect": break; }',
      'const legacy = { "T3 Code": 1 };',
      'return "T3 Code (Nightly)";',
    ].join("\n");
    const { text } = renameUpstreamNames("apps/desktop/src/example.ts", source);
    expect(text).toBe(source.replace('label: "T3 Connect"', 'label: "styal Link"'));
  });
});
