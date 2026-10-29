import { describe, expect, it } from "vite-plus/test";

import { findUpstreamNames } from "./upstream-naming.ts";

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
