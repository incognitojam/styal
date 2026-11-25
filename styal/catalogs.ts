#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";

// Re-key branded messages while retaining the upstream locale text where unambiguous.
for (const app of ["web", "mobile", "desktop"]) {
  const dir = `apps/${app}`;
  const catalogs = `${dir}/src/i18n/translations`;
  const before = new Map(
    NodeFS.readdirSync(catalogs)
      .filter((f) => f.endsWith(".json"))
      .map((f) => [
        f,
        JSON.parse(NodeFS.readFileSync(`${catalogs}/${f}`, "utf8")) as Record<string, unknown>,
      ]),
  );
  const oldEnglish = before.get("en.json")!;
  const command =
    app === "desktop" ? ["scripts/i18n-generate.mjs"] : ["node_modules/gt/bin/main.js", "generate"];
  NodeChildProcess.execFileSync(process.execPath, command, { cwd: dir, stdio: "inherit" });
  const english = JSON.parse(NodeFS.readFileSync(`${catalogs}/en.json`, "utf8")) as Record<
    string,
    unknown
  >;
  for (const [file, old] of before) {
    if (file === "en.json") continue;
    const next = JSON.parse(NodeFS.readFileSync(`${catalogs}/${file}`, "utf8"));
    for (const [key, text] of Object.entries(english)) {
      if (Object.hasOwn(old, key)) continue;
      const matches = Object.entries(oldEnglish).filter(
        ([, value]) => JSON.stringify(value) === JSON.stringify(text),
      );
      if (matches.length === 1 && Object.hasOwn(old, matches[0]![0]))
        next[key] = old[matches[0]![0]];
    }
    NodeFS.writeFileSync(`${catalogs}/${file}`, JSON.stringify(next, null, 2) + "\n");
  }
}
