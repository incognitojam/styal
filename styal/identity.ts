#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

// Run only on a pristine upstream tree. Fail before writing if an anchor has drifted.
const files = NodeChildProcess.execFileSync(
  "git",
  ["ls-files", "-z", "apps", "packages", "scripts", "package.json"],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
)
  .split("\0")
  .filter(Boolean);
const output = new Map<string, string>();
for (const file of files) {
  if (
    !(/^(apps|packages|scripts)\//.test(file) || file === "package.json") ||
    /fixtures\//.test(file) ||
    !/\.(?:ts|tsx|js|mjs|cjs|json|html|xml|sh|ps1|webmanifest|astro|txt|swift|kt|py)$/.test(file)
  )
    continue;
  const source = NodeFS.readFileSync(file, "utf8");
  let text = source
    .replaceAll("T3 Code", "styal")
    .replace(
      /((?:[\w-]+\\+\.)*)t3(\\+)\.codes/g,
      (_match, prefix: string, escape: string) =>
        `${prefix}restart${escape}.styal${escape}.invalid`,
    )
    .replace(/((?:[\w-]+\.)*)t3\.codes\b/g, "$1restart.styal.invalid")
    .replace(/(<code\b[^>]*>\s*)t3(?=[ <])/g, "$1styal")
    .replace(/\.t3(?=[/\\"'`)}]|$)/gm, ".styal")
    .replaceAll("com.t3tools.t3code", "build.styal.app")
    .replaceAll("com.t3tools.T3Code", "build.styal.app")
    .replace(/(["'`])t3code(-dev|-preview)\1/g, "$1styal$2$1")
    .replaceAll("t3code://", "styal://")
    .replaceAll("t3code-dev://", "styal-dev://")
    .replaceAll("t3code.service", "styal.service")
    .replaceAll("app-t3code", "app-styal")
    .replaceAll("t3code.plist", "styal.plist")
    .replaceAll("t3.mjs", "styal.mjs")
    .replace(/(["'`])t3code(-dev)?:/g, "$1styal$2:")
    .replaceAll("/^t3code(?:", "/^styal(?:")
    .replace(/https:\/\/(?:www\.)?t3codes\.com\b/g, "https://restart.styal.invalid")
    .replaceAll(
      "https://github.com/pingdotgg/t3code/releases",
      "https://updates.styal.invalid/releases",
    )
    .replaceAll("https://github.com/pingdotgg/t3code", "https://github.com/incognitojam/styal")
    .replaceAll(
      "https://raw.githubusercontent.com/pingdotgg/t3code",
      "https://updates.styal.invalid",
    )
    .replaceAll("pingdotgg/t3code", "incognitojam/styal")
    .replaceAll("https://registry.npmjs.org/t3/", "https://registry.npmjs.org/styal/")
    .replaceAll("https://t3.chat", "https://restart.styal.invalid")
    .replaceAll("https://apps.apple.com", "https://restart.styal.invalid")
    .replaceAll("https://play.google.com", "https://restart.styal.invalid")
    .replaceAll('"https://api.axiom.co/v1/traces"', '"https://observe.styal.invalid"')
    .replaceAll("phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m", "")
    .replaceAll(
      "https://u.expo.dev/d763fcb8-d37c-41ea-a773-b54a0ab4a454",
      "https://updates.styal.invalid/mobile",
    )
    .replaceAll('"ARK85ZXQ4Z"', '""')
    .replaceAll('"d763fcb8-d37c-41ea-a773-b54a0ab4a454"', '""');
  if (
    /^(?:apps\/desktop\/|apps\/mobile\/(?:app.config|modules\/t3-agent-notifications\/|src\/features\/agent-awareness\/androidNotifications)|apps\/server\/src\/(?:cliCompileCache|cloud\/bootService|serviceLauncher|config|terminal\/Manager)|apps\/web\/src\/observability\/|packages\/shared\/src\/(?:codexAuthHandoff|providerAuthReturnUrl|promptLinks|relayTracing)|scripts\/build-desktop-artifact|packages\/(?:provider-grok|source-control-gitcafe)\/)/.test(
      file,
    )
  ) {
    text = text.replace(/(["'`])t3code\1/g, "$1styal$1");
  }
  // CLI literals and command strings, without renaming internal t3 service identifiers.
  {
    text = text
      .replace(/(["'`])t3(?=["'` @]|\.exe\b|\.cmd\b|\.mjs\b)/g, "$1styal")
      .replaceAll("/bin/t3", "/bin/styal")
      .replaceAll("/t3.exe", "/styal.exe")
      .replaceAll("manifest.bin.t3", "manifest.bin.styal")
      .replace(/\bbin: \{ t3:/g, "bin: { styal:")
      .replaceAll('{ t3: "./bin/styal.mjs"', '{ styal: "./bin/styal.mjs"')
      .replaceAll("Schema.Struct({ t3: Schema.String", "Schema.Struct({ styal: Schema.String")
      .replaceAll("bin/t3", "bin/styal")
      .replaceAll("t3@", "styal@")

      .replaceAll("\\/t3$/", "\\/styal$/");
  }
  if (file.startsWith("scripts/build-npm-launcher")) text = text.replaceAll('"/t3"', '"/styal"');
  if (file.startsWith("scripts/install.")) {
    for (const token of ["${repo}", "$repo"]) {
      text = text
        .replaceAll(
          `https://github.com/${token}/releases`,
          "https://updates.styal.invalid/releases",
        )
        .replaceAll(
          `https://api.github.com/repos/${token}/releases`,
          "https://updates.styal.invalid/releases",
        );
    }
  }
  if (file.endsWith("package.json"))
    text = text
      .replaceAll('"name": "t3"', '"name": "styal"')
      .replaceAll('"t3": "./dist/bin.mjs"', '"styal": "./dist/bin.mjs"');
  if (file === "apps/server/package.json") text = text.replace('"name": "styal"', '"name": "t3"');
  if (text !== source) output.set(file, text);
}
function edit(file: string, from: string | RegExp, to: string) {
  const before = output.get(file) ?? NodeFS.readFileSync(file, "utf8");
  const after = before.replace(from, to);
  if (after === before) throw new Error(`Identity anchor missing: ${file}: ${from}`);
  output.set(file, after);
}
edit(
  "apps/server/src/telemetry/AnalyticsService.ts",
  "const telemetryEnabled = Effect.suspend(() => {",
  "const telemetryEnabled = Effect.suspend(() => {\n    if (!telemetryConfig.posthogKey || telemetryConfig.posthogHost.includes('.invalid')) return Effect.succeed(false);",
);
edit(
  "apps/desktop/src/updates/DesktopUpdatePolicy.ts",
  "Effect.map(({ policy }) => policy)",
  'Effect.map((): UpdatePolicy => ({ mode: "off", feedUrl: undefined, allowNightly: false, message: "Updates are disabled in restart builds." }))',
);
edit(
  "apps/server/src/cloud/npmRelease.ts",
  /export const layer = Layer.effect\(NpmRelease, make\(\)\).pipe\([\s\S]*?\n\);/,
  'export const layer = Layer.succeed(NpmRelease, { get: Effect.fn("NpmRelease.get")(() => Effect.succeed(null)) });',
);

edit(
  "packages/shared/src/cliRelease.ts",
  "const CLI_RELEASE_DEFAULT_BASE_URL = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases/download`;",
  'const CLI_RELEASE_DEFAULT_BASE_URL = "https://updates.styal.invalid/releases/download";',
);
edit(
  "packages/shared/src/cliRelease.ts",
  "return `https://api.github.com/repos/${CLI_RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`;",
  "return `https://updates.styal.invalid/releases?page=${page}`;",
);
edit(
  "apps/mobile/app.config.ts",
  'enabled: repoEnv.T3CODE_MOBILE_UPDATES_ENABLED !== "0",',
  "enabled: false,",
);
edit("apps/mobile/app.config.ts", 'owner: "pingdotgg",', 'owner: "styal-restart",');
edit(
  "apps/server/src/cli/server.ts",
  "  const run = Effect.raceFirst(",
  '  yield* Effect.logInfo("styal data directory", { baseDir: config.baseDir });\n  const run = Effect.raceFirst(',
);
// Relay and Clerk configuration deliberately stay unset; no production .env may enter a build.
edit(
  "scripts/lib/public-config.ts",
  "  return {\n    ...rootEnv,",
  "  for (const source of [rootEnv, localEnv, baseEnv]) {\n    for (const [key, value] of Object.entries(source)) {\n      if (value && /(?:RELAY|CLERK|POSTHOG|OTLP|OBSERVE)/.test(key)) {\n        throw new Error(`Restart builds require unset service configuration: ${key}`);\n      }\n    }\n  }\n  return {\n    ...rootEnv,",
);
for (const [file, text] of output) {
  if (
    /https?:\/\/(?:[\w.-]+\.)?t3\.codes\b|raw\.githubusercontent\.com\/pingdotgg\/t3code|registry\.npmjs\.org\/t3\//.test(
      text,
    ) &&
    !file.includes("npmRelease")
  ) {
    throw new Error(`Unmapped upstream endpoint: ${file}`);
  }
}
const ignore = NodeFS.readFileSync(".gitignore", "utf8");
if (!ignore.split("\n").includes(".styal/"))
  output.set(".gitignore", ignore.trimEnd() + "\n.styal/\n");
output.set(".task-cache.json", '{ "endpoint": "https://cache.styal.invalid" }\n');
for (const [file, text] of output) NodeFS.writeFileSync(file, text);
NodeFS.renameSync("scripts/npm-launcher/t3.mjs", "scripts/npm-launcher/styal.mjs");
for (const file of files) {
  if (file.includes("com.t3tools.t3code"))
    NodeFS.renameSync(file, file.replaceAll("com.t3tools.t3code", "build.styal.app"));
}
console.log(`Identity: ${output.size} files transformed; service feeds disabled.`);

NodeChildProcess.execFileSync(process.execPath, ["styal/catalogs.ts"], { stdio: "inherit" });
// Measure the release's own advertised context after replacing the product name.
const budgetTest = "apps/server/src/provider/AgentContextBudget.test.ts";
const probe = "apps/server/src/provider/StyalContextMeasurement.test.ts";
if (NodeFS.existsSync(probe)) throw new Error("Context measurement probe already exists");
const testSource = NodeFS.readFileSync(budgetTest, "utf8");
if (!testSource.includes(").toEqual(budget);"))
  throw new Error("Context measurement anchor changed");
try {
  NodeFS.writeFileSync(
    probe,
    testSource.replace(
      ").toEqual(budget);",
      ').toEqual(measured); console.log("STYAL_BUDGET=" + JSON.stringify(measured));',
    ),
  );
  const measured = NodeChildProcess.execFileSync("vp", ["test", "run", probe, "--silent=false"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const match = measured.match(/STYAL_BUDGET=(\{[^\n]+\})/);
  if (!match) throw new Error("Context budget measurement missing");
  NodeFS.writeFileSync(
    "apps/server/src/provider/agentContextBudget.json",
    JSON.stringify(JSON.parse(match[1]!), null, 2) + "\n",
  );
} finally {
  NodeFS.unlinkSync(probe);
}
NodeChildProcess.execFileSync(
  "vp",
  ["fmt", ...output.keys(), "apps/server/src/provider/agentContextBudget.json"].filter(
    (file) => !file.includes("com.t3tools.t3code") && !file.endsWith("npm-launcher/t3.mjs"),
  ),
  { stdio: "inherit" },
);
