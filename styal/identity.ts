#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import { installArtwork } from "./artwork.ts";

const productName = "styal";
const repository = "incognitojam/styal";
const releasesUrl = "https://updates.styal.invalid/releases";
const [repositoryOwner, repositoryName] = repository.split("/");
const appleTeamId = "";
const mobileConfig = NodeFS.readFileSync("apps/mobile/app.config.ts", "utf8");
const upstreamAppleTeamId = mobileConfig.match(/appleTeamId: "([^"]+)"/)?.[1];
if (!upstreamAppleTeamId) throw new Error("Identity anchor missing: Apple team ID");
const upstreamExpoProjectId = mobileConfig.match(/projectId: "([^"]+)"/)?.[1];
if (!upstreamExpoProjectId) throw new Error("Identity anchor missing: Expo project ID");

// Run only on a pristine upstream tree. Fail before writing if an anchor has drifted.
const files = NodeChildProcess.execFileSync(
  "git",
  [
    "ls-files",
    "-z",
    "apps",
    "packages",
    "scripts",
    "package.json",
    ".github/triage/PLAYBOOK.md",
    "packaging/aur/scripts/release.sh",
    "packaging/aur/t3code-bin/PKGBUILD",
    "packaging/aur/t3code-nightly-bin/PKGBUILD",
  ],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
)
  .split("\0")
  .filter(Boolean);
const output = new Map<string, string>();
for (const file of files) {
  if (
    !(
      /^(apps|packages|scripts)\//.test(file) ||
      file === "package.json" ||
      [
        ".github/triage/PLAYBOOK.md",
        "packaging/aur/scripts/release.sh",
        "packaging/aur/t3code-bin/PKGBUILD",
        "packaging/aur/t3code-nightly-bin/PKGBUILD",
      ].includes(file)
    ) ||
    /fixtures\//.test(file) ||
    (!/\.(?:ts|tsx|js|mjs|cjs|json|html|xml|sh|ps1|webmanifest|astro|txt|swift|kt|py|nsh)$/.test(
      file,
    ) &&
      file !== ".github/triage/PLAYBOOK.md" &&
      !file.endsWith("/PKGBUILD"))
  )
    continue;
  const source = NodeFS.readFileSync(file, "utf8");
  let text = source;
  if (file === "apps/desktop/src/app/DesktopLinuxUrlHandler.test.ts") {
    text = text
      .replaceAll("com.t3tools.T3Code", "org.example.Demo")
      .replaceAll("com.t3tools.t3code", "org.example.demo");
  }
  if (
    [
      "apps/server/src/device/EasDeviceHost.test.ts",
      "apps/server/src/device/easProjectId.test.ts",
    ].includes(file)
  )
    text = text.replaceAll(upstreamExpoProjectId, "00000000-0000-4000-8000-000000000001");
  if (file === "packages/source-control-github/src/server/GitHubAppSignIn.test.ts")
    text = text.replaceAll('login: "pingdotgg"', `login: ${JSON.stringify(repositoryOwner)}`);
  if (file === "packages/client-runtime/src/promptLinks.test.ts")
    text = text.replaceAll(
      'ids("pingdotgg", "t3code")',
      `ids(${JSON.stringify(repositoryOwner)}, ${JSON.stringify(repositoryName)})`,
    );
  if (file === "packages/ssh/src/tunnel.test.ts")
    text = text.replaceAll("${runtimeDir}/t3", `\${runtimeDir}/${productName}`);
  if (file === "apps/server/src/cli/install.test.ts")
    text = text.replaceAll("}/t3\\n", `}/${productName}\\n`);
  if (
    ["apps/server/src/cli/invocation.test.ts", "apps/server/src/cli/uninstall.test.ts"].includes(
      file,
    )
  )
    text = text.replace(/(\d+\.\d+\.\d+\/)t3(?=["'`])/g, `$1${productName}`);
  if (file === "apps/server/src/cli/uninstall.test.ts")
    text = text.replaceAll('"copy/t3"', `"copy/${productName}"`);
  if (file === "apps/server/src/cli/update.test.ts")
    text = text
      .replaceAll('"alias/t3"', `"alias/${productName}"`)
      .replaceAll('"unrunnable/t3"', `"unrunnable/${productName}"`);
  if (file.startsWith("apps/server/src/cli/invocation."))
    text = text
      .replaceAll("node_modules/t3", `node_modules/${productName}`)
      .replaceAll("node_modules\\/t3\\/", `node_modules\\/${productName}\\/`)
      .replaceAll("bin\\/t3\\.mjs", `bin\\/${productName}\\.mjs`)
      .replaceAll(".bun/install/cache/t3/", `.bun/install/cache/${productName}/`)
      .replaceAll('"shadow-dir/t3"', `"shadow-dir/${productName}"`)
      .replaceAll('"shadow-file/t3"', `"shadow-file/${productName}"`);
  if (
    file.startsWith("apps/server/src/triage/triagePrompt.") ||
    file === ".github/triage/PLAYBOOK.md"
  )
    text = text
      .replaceAll("\\`t3\\`", `\\\`${productName}\\\``)
      .replaceAll("npx t3 ", `npx ${productName} `);
  if (file === "packages/client-runtime/src/operations/projects.test.ts")
    text = text.replaceAll('"t3code"', JSON.stringify(repositoryName));
  if (file === "apps/desktop/src/electron/ElectronProtocol.test.ts")
    text = text.replaceAll(" t3code-dev: ", ` ${productName}-dev: `);
  if (file === "apps/desktop/src/snapShot/snapShot.test.ts")
    text = text.replaceAll("t3code", productName);
  if (
    file === "apps/mobile/src/features/workflows/WorkflowStepCard.test.tsx" ||
    file === "apps/server/src/workflows/Workflows.test.ts" ||
    file === "apps/web/src/components/workflows/WorkflowRunsView.browser.test.tsx"
  )
    text = text
      .replaceAll("t3 workflow signal", `${productName} workflow signal`)
      .replaceAll("t3 CLI", `${productName} CLI`);
  if (file === "apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts")
    text = text.replaceAll("Web search: t3 code", `Web search: ${productName} code`);
  if (file === "packages/ssh/src/tunnel.ts")
    text = text
      .replaceAll("command -v t3 ", `command -v ${productName} `)
      .replace(/(T3_(?:RUNTIME_DIR|STAGING)\/)t3\b/g, `$1${productName}`);
  if (file === "apps/server/src/cloud/pinnedRuntime.ts")
    text = text.replaceAll("]t3(?:", `]${productName}(?:`);
  if (file === "apps/server/src/serviceLauncher.ts")
    text = text.replaceAll("]t3", `]${productName}`);
  if (file.endsWith("/PKGBUILD"))
    text = text
      .replaceAll("/bin/t3code", `/bin/${productName}`)
      .replaceAll("ln -s t3code", `ln -s ${productName}`)
      .replaceAll("Exec=t3code", `Exec=${productName}`)
      .replaceAll("/apps/t3code", `/apps/${productName}`)
      .replaceAll("Icon=t3code", `Icon=${productName}`);
  text = text
    .replaceAll("dist-exe/t3", `dist-exe/${productName}`)
    .replaceAll("/opt/T3 Code/t3code", "/opt/Example App/styal")
    .replaceAll("T3 Code", productName)
    .replaceAll("T3+Code", encodeURIComponent(productName).replaceAll("%20", "+"))
    .replaceAll("T3-Code", "styal")
    .replaceAll("T3%20Code", "styal")
    .replace(
      /(\b|\\[nr])T3(?= (?:[Ss]erver|desktop|threads?|team|tools?|home|process|system|operations|requests|environments?|project|stops|could)\b)/g,
      "$1styal",
    )
    .replace(
      /((?:[\w-]+\\+\.)*)t3(\\+)\.codes/g,
      (_match, prefix: string, escape: string) =>
        `${prefix}restart${escape}.styal${escape}.invalid`,
    )
    .replace(
      /((?:[\w-]+\.)*)t3\.codes\b/gi,
      (match, prefix: string) =>
        `${prefix}${match.endsWith("T3.CODES") ? "RESTART.STYAL.INVALID" : "restart.styal.invalid"}`,
    )
    .replace(/(<code\b[^>]*>\s*)t3(?=[ <])/g, "$1styal")
    .replace(/\.t3(?=[/\\"'`)}]|$)/gm, ".styal")
    .replaceAll("com.t3tools.t3code", "build.styal.app")
    .replaceAll("com\\.t3tools\\.t3code", "build\\.styal\\.app")
    .replaceAll("com.t3tools.T3Code", "build.styal.app")
    .replace(/(["'`])t3code(-dev|-preview)\1/g, "$1styal$2$1")
    .replaceAll("t3code.service", "styal.service")
    .replaceAll("t3code-task.xml", `${productName}-task.xml`)
    .replace(/(versions\/[^/\s]+\/)t3\b/g, `$1${productName}`)
    .replace(/(\\+)t3\.exe\b/g, `$1${productName}.exe`)
    .replaceAll("<version>/t3", `<version>/${productName}`)
    .replaceAll("x-scheme-handler/t3code", "x-scheme-handler/styal")
    .replaceAll("t3code/extension-backups", "styal/extension-backups")
    .replaceAll("t3code/compile-cache", `${productName}/compile-cache`)
    .replaceAll("app-t3code", "app-styal")
    .replaceAll("t3code.plist", "styal.plist")
    .replaceAll("t3.mjs", "styal.mjs")
    // Release metadata keeps its unquoted t3code: wire key.
    .replace(/\bt3code(-dev|-preview)?:(?=[/\\"'`])/g, "styal$1:")
    .replaceAll("/^t3code(?:", "/^styal(?:")
    .replaceAll("/^t3code(", "/^styal(")
    .replace(/https:\/\/(?:www\.)?t3codes\.com\b/g, "https://restart.styal.invalid")
    .replaceAll("https://github.com/pingdotgg/t3code/releases", releasesUrl)
    .replaceAll("https://github.com/pingdotgg/t3code", `https://github.com/${repository}`)
    .replaceAll(
      "https://raw.githubusercontent.com/pingdotgg/t3code",
      "https://updates.styal.invalid",
    )
    .replaceAll(
      "https://api.github.com/repos/pingdotgg/t3code/releases?per_page=100&page=",
      `${releasesUrl}?page=`,
    )
    .replace(/pingdotgg\/t3code/gi, (match) =>
      match === match.toLowerCase()
        ? repository
        : repository.replace(
            /(^|\/)([a-z])/g,
            (_match, prefix: string, letter: string) => prefix + letter.toUpperCase(),
          ),
    )
    .replace(
      /owner: "pingdotgg",(\s+)(repo|name): "t3code"/g,
      (_match, spacing: string, field: string) =>
        `owner: ${JSON.stringify(repositoryOwner)},${spacing}${field}: ${JSON.stringify(repositoryName)}`,
    )
    .replaceAll("https://registry.npmjs.org/t3/", "https://registry.npmjs.org/styal/")
    .replaceAll("https://t3.chat", "https://restart.styal.invalid")
    .replaceAll("https://apps.apple.com", "https://restart.styal.invalid")
    .replaceAll("https://play.google.com", "https://restart.styal.invalid")
    .replaceAll('"https://api.axiom.co/v1/traces"', '"https://observe.styal.invalid"')
    .replaceAll("phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m", "")
    .replaceAll(
      `https://u.expo.dev/${upstreamExpoProjectId}`,
      "https://updates.styal.invalid/mobile",
    )
    .replaceAll(upstreamAppleTeamId, appleTeamId)
    .replaceAll(JSON.stringify(upstreamExpoProjectId), '""');
  if (file.includes("/i18n/translations/"))
    text = text.replace(/\bT3\b(?!(?:\s+|[-‑–])(?:Connect|Chat)\b|[-_]INSIGHT)/g, "styal");
  if (
    /^(?:apps\/desktop\/|apps\/mobile\/(?:app.config|modules\/t3-agent-notifications\/|src\/features\/agent-awareness\/androidNotifications)|apps\/server\/src\/(?:cliCompileCache|cloud\/bootService|serviceLauncher|config|terminal\/Manager)|apps\/web\/src\/observability\/|packages\/shared\/src\/(?:codexAuthHandoff|providerAuthReturnUrl|promptLinks|relayTracing)|scripts\/build-desktop-artifact|packages\/(?:provider-grok|source-control-gitcafe)\/)/.test(
      file,
    )
  ) {
    text = text.replace(/(["'`])t3code\1/g, "$1styal$1");
  }
  // CLI literals and command strings, without renaming internal t3 service identifiers.
  {
    // Branch fixtures and workspace package IDs keep their internal names.
    if (
      ![
        "apps/server/src/vcs/GitVcsDriverCore.test.ts",
        "scripts/check-changed.ts",
        "apps/server/src/cli/config.test.ts",
        "apps/web/src/components/CommandPalette.logic.test.ts",
        "packages/client-runtime/src/state/filesystem.test.ts",
        "packages/shared/src/composerContextReferences.test.ts",
        "packages/shared/src/observability.test.ts",
        "apps/server/src/feedback/scrubFeedback.test.ts",
      ].includes(file)
    )
      text = text.replace(/(["'`])t3(?=["'` @]|\.exe\b|\.cmd\b|\.mjs\b)/g, `$1${productName}`);
    text = text
      .replaceAll("/bin/t3", "/bin/styal")
      .replaceAll("/t3.exe", "/styal.exe")
      .replaceAll("manifest.bin.t3", "manifest.bin.styal")
      .replace(/\bbin: \{ t3:/g, "bin: { styal:")
      .replaceAll('{ t3: "./bin/styal.mjs"', '{ styal: "./bin/styal.mjs"')
      .replaceAll("Schema.Struct({ t3: Schema.String", "Schema.Struct({ styal: Schema.String")
      .replaceAll("bin/t3", "bin/styal")
      .replaceAll("t3\\.cmd$", "styal\\.cmd$")
      .replaceAll("t3@", "styal@")

      .replaceAll("\\/t3$/", "\\/styal$/");
  }
  if (file.startsWith("scripts/build-npm-launcher")) text = text.replaceAll('"/t3"', '"/styal"');
  if (file.startsWith("scripts/install.")) {
    text = text
      .replace(/\bt3\b(?!-)/g, productName)
      .replaceAll("t3 install:", `${productName} install:`)
      .replaceAll("%st3", `%s${productName}`);
    for (const token of ["${repo}", "$repo"]) {
      text = text
        .replaceAll(`https://github.com/${token}/releases`, releasesUrl)
        .replaceAll(`https://api.github.com/repos/${token}/releases`, releasesUrl);
    }
  }
  if (file.endsWith("package.json"))
    text = text
      .replaceAll('"name": "t3"', '"name": "styal"')
      .replaceAll('"t3": "./dist/bin.mjs"', '"styal": "./dist/bin.mjs"');
  if (file === "apps/server/package.json") text = text.replace('"name": "styal"', '"name": "t3"');
  if (file === "apps/server/src/cli/invocation.test.ts")
    text = text.replaceAll(" t3 browser setup", ` ${productName} browser setup`);
  if (file === "scripts/notify-discord-release.test.ts")
    text = text.replaceAll(releasesUrl, `https://github.com/${repository}/releases`);
  if (file === "scripts/install.test.ts")
    text = text
      .replaceAll(
        "/https:\\/\\/(api\\.)?github\\.com/g",
        "/https:\\/\\/updates\\.styal\\.invalid/g",
      )
      .replaceAll(`/${repository}/releases/latest`, `${new URL(releasesUrl).pathname}/latest`)
      .replaceAll(`/repos/${repository}/releases`, new URL(releasesUrl).pathname);
  // These lexical samples and MCP aliases are inputs, rather than product identity.
  if (
    [
      "packages/shared/src/speech.test.ts",
      "packages/shared/src/t3McpToolPresentation.test.ts",
    ].includes(file)
  )
    text = source;
  if (file === "packages/shared/src/paletteSearch.test.ts")
    text = source
      .replaceAll('"t3/', `"${productName}/`)
      .replace(/\bt3-(?=[0-9a-f]{4})/g, `${productName}-`)
      .replaceAll(
        'scoreThreadSearch("t3", flat',
        `scoreThreadSearch(${JSON.stringify(productName)}, flat`,
      )
      .replaceAll(
        'scoreThreadSearch("t3 connect", flat',
        `scoreThreadSearch(${JSON.stringify(`${productName} connect`)}, flat`,
      )
      .replaceAll("flat t3-<hex>", `flat ${productName}-<hex>`)
      .replaceAll("a `t3` branch blocks", `a \`${productName}\` branch blocks`);
  if (file === "packages/source-control-bitbucket/src/server/BitbucketApi.test.ts")
    text = text.replaceAll("/t3code", `/${repositoryName}`);
  if (text !== source) output.set(file, text);
}
function edit(file: string, from: string | RegExp, to: string) {
  const before = output.get(file) ?? NodeFS.readFileSync(file, "utf8");
  const after = before.replace(from, to);
  if (after === before) throw new Error(`Identity anchor missing: ${file}: ${from}`);
  output.set(file, after);
}
edit(
  ".github/workflows/ci.yml",
  "apps/server/dist-exe/t3 --version",
  `apps/server/dist-exe/${productName} --version`,
);
edit(
  "packages/client-runtime/src/state/filesystem.test.ts",
  'expect(names("t3")).not.toContain(',
  `expect(names(${JSON.stringify(productName)})).not.toContain(`,
);
edit(
  "apps/desktop/src/window/DesktopWindow.test.ts",
  '"t3code:app"',
  JSON.stringify(`${productName}:app`),
);
edit(
  "evals/mcp-tool-use/run.test.ts",
  '"## T3 Code devices"',
  JSON.stringify(`## ${productName} devices`),
);
edit(
  "apps/server/src/orchestration-v2/ThreadLaunchService.test.ts",
  "/^t3\\/",
  `/^${productName}\\/`,
);
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

edit("apps/server/src/cloud/npmRelease.ts", "{ FetchHttpClient, HttpClient }", "{ HttpClient }");

edit(
  "packages/shared/src/cliRelease.ts",
  /const CLI_RELEASE_REPOSITORY = "incognitojam\/styal";\nexport const CLI_RELEASES_PAGE_URL = `https:\/\/github.com\/\$\{CLI_RELEASE_REPOSITORY}\/releases`;/,
  `export const CLI_RELEASES_PAGE_URL = ${JSON.stringify(releasesUrl)};`,
);
edit(
  "packages/shared/src/cliRelease.ts",
  "const CLI_RELEASE_DEFAULT_BASE_URL = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases/download`;",
  `const CLI_RELEASE_DEFAULT_BASE_URL = ${JSON.stringify(`${releasesUrl}/download`)};`,
);
edit(
  "packages/shared/src/cliRelease.ts",
  "return `https://api.github.com/repos/${CLI_RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`;",
  "return `" + releasesUrl + "?page=${page}`;",
);
edit(
  "apps/server/src/cli/update.test.ts",
  'assert.equal(url.origin, "https://api.github.com");',
  `assert.equal(url.origin, ${JSON.stringify(new URL(releasesUrl).origin)});`,
);
edit(
  "apps/server/src/cli/update.test.ts",
  `assert.equal(url.pathname, ${JSON.stringify(`/repos/${repository}/releases`)});`,
  `assert.equal(url.pathname, ${JSON.stringify(new URL(releasesUrl).pathname)});`,
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
for (const file of files) {
  if (!/\/(?:codex|muse|kiro)_transcript\.ndjson$/.test(file)) continue;
  const source = NodeFS.readFileSync(file, "utf8");
  const text = source
    .split("\n")
    .map((line) => {
      if (!line.includes('"type":"expect_outbound"')) return line;
      if (line.includes('"method":"initialize"'))
        return line
          .replaceAll(
            '"clientInfo":{"name":"T3 Code","title":"T3 Code"',
            `"clientInfo":{"name":${JSON.stringify(productName)},"title":${JSON.stringify(productName)}`,
          )
          .replaceAll(
            '"clientInfo":{"name":"t3_code","title":"T3 Code"',
            `"clientInfo":{"name":"t3_code","title":${JSON.stringify(productName)}`,
          );
      if (line.includes('"method":"turn/start"') || line.includes('"method":"session/prompt"'))
        return line
          .replaceAll(
            '"text":"[T3 Code: the agent in T3 thread ',
            `"text":"[${productName}: the agent in ${productName} thread `,
          )
          .replace(/<runtime_info>.*?<\/runtime_info>/g, (notes) =>
            notes.replaceAll("T3 Code", productName),
          );
      return line;
    })
    .join("\n");
  if (text !== source) output.set(file, text);
}
const ignore = NodeFS.readFileSync(".gitignore", "utf8");
if (!ignore.split("\n").includes(".styal/"))
  output.set(".gitignore", ignore.trimEnd() + "\n.styal/\n");
output.set(".task-cache.json", '{ "endpoint": "https://cache.styal.invalid" }\n');
for (const [file, text] of output) NodeFS.writeFileSync(file, text);
NodeFS.renameSync("scripts/npm-launcher/t3.mjs", "scripts/npm-launcher/styal.mjs");
for (const file of files) {
  if (file.includes("com.t3tools.t3code"))
    NodeFS.renameSync(
      file,
      file
        .replaceAll("com.t3tools.t3code", "build.styal.app")
        .replaceAll("com\\.t3tools\\.t3code", "build\\.styal\\.app"),
    );
}
installArtwork();
console.log(`Identity: ${output.size} files transformed; service feeds disabled.`);

NodeChildProcess.execFileSync(
  "vp",
  ["fmt", ...output.keys(), "apps/mobile/src/components/T3Wordmark.tsx"].filter(
    (file) =>
      !file.includes("com.t3tools.t3code") &&
      !file.endsWith("npm-launcher/t3.mjs") &&
      !file.endsWith(".ndjson") &&
      !file.endsWith("/PKGBUILD"),
  ),
  { stdio: "inherit" },
);

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
