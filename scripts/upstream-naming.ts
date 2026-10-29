// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import ts from "typescript-legacy";

/**
 * Upstream product names that must not reach styal users or agents. Upstream
 * intake brings new messages that use them, and nothing else notices. Bare
 * "T3" counts when used as a name ("T3 server", "T3's browser", "T3-owned");
 * "T3 home" is the glossary term for the data directory, and "T3 Chat" is a
 * theme named after another product.
 */
const UPSTREAM_NAME = /T3 Code|T3 Connect|t3\.codes|\bT3(?! home\b| Chat\b)(?=[ '’]|-[a-z])/u;

/**
 * Files whose strings may keep an upstream name, each with the reason. A path
 * ending in `/` covers every file below it.
 */
const UPSTREAM_NAMING_EXCEPTIONS: ReadonlyArray<{
  readonly path: string;
  readonly reason: string;
}> = [
  {
    path: "apps/server/src/dataImport/",
    reason: "Import messages name the upstream T3 Code install being imported.",
  },
  {
    path: "apps/web/src/components/import/",
    reason: "Import screens name the upstream T3 Code install being imported.",
  },
  {
    path: "apps/web/src/components/settings/settingsSearch.ts",
    reason: "The Import from T3 Code settings entry names the upstream install.",
  },
  {
    path: "apps/desktop/src/app/DesktopLegacyLocalStorage.ts",
    reason: "Upstream V1 desktop profile directory names.",
  },
  {
    path: "apps/server/src/mcp/toolkits/",
    reason: "Tool descriptions and titles are advertised through renderStyalProductName.",
  },
  {
    path: "packages/provider-core/src/server/orchestrationInstructions.ts",
    reason: "Instructions are delivered through renderStyalProductName.",
  },
  {
    path: "packages/shared/src/htmlRender.ts",
    reason:
      "Its guides are part of MCP tool descriptions, advertised through renderStyalProductName.",
  },
  {
    path: "packages/shared/src/t3McpToolPresentation.ts",
    reason: "Tool labels are rewritten by styalToolDefinition before display.",
  },
  {
    path: "apps/desktop/src/app/DesktopCliCommand.ts",
    reason: "Embedded PowerShell uses T3 as a type namespace.",
  },
  {
    path: "apps/server/src/device/deviceToolMaintenance.ts",
    reason: "Embedded helper script comments.",
  },
  {
    path: "packages/provider-pi/src/server/mcpExtensionSource.ts",
    reason: "Embedded extension source comments.",
  },
  {
    path: "apps/server/src/provider/CodexDeveloperInstructions.ts",
    reason: "Rewrites the upstream name in Codex's instructions.",
  },
  {
    path: "packages/provider-muse/src/server/sdk.ts",
    reason: "The Muse clientInfo title is part of the recorded replay transcripts.",
  },
  {
    path: "packages/provider-testing/",
    reason: "Test-only replay workspace identity.",
  },
  {
    path: "packages/contracts/src/t3ProjectFile.ts",
    reason: "Upstream t3.json schema URL and description; styal.json is the fork's own file.",
  },
  {
    path: "apps/web/src/legalLinks.ts",
    reason: "styal has no legal documents of its own yet; links upstream's.",
  },
  {
    path: "apps/mobile/src/features/settings/lib/legal-document-url.ts",
    reason: "styal has no legal documents of its own yet; links upstream's.",
  },
];

const SCANNED_ROOTS = [
  ":(glob)apps/*/src/**",
  ":(glob)apps/mobile/modules/**",
  ":(glob)apps/desktop/gnome-extension/**",
  ":(glob)packages/*/src/**",
];
const SKIPPED_PATH =
  /^apps\/marketing\/|\.test\.|\.fixture\.|\.testkit\.|\/testkit\/|\/fixtures\/|\/__tests__\/|\.d\.ts$/u;
const SCRIPT_FILE = /\.(?:ts|tsx|mts|js|mjs|cjs)$/u;
const NATIVE_FILE = /\.(?:kt|swift|java)$/u;

interface UpstreamNameFinding {
  readonly path: string;
  readonly line: number;
  readonly name: string;
  readonly text: string;
}

const isException = (path: string) =>
  UPSTREAM_NAMING_EXCEPTIONS.some((exception) =>
    exception.path.endsWith("/") ? path.startsWith(exception.path) : path === exception.path,
  );

const finding = (path: string, line: number, text: string): UpstreamNameFinding | undefined => {
  const match = UPSTREAM_NAME.exec(text);
  return match === null
    ? undefined
    : { path, line, name: match[0], text: text.replace(/\s+/gu, " ").trim() };
};

/** Upstream names in the string literals, template text and JSX text of one source file. */
export function findUpstreamNames(
  path: string,
  source: string,
): ReadonlyArray<UpstreamNameFinding> {
  if (!UPSTREAM_NAME.test(source)) return [];
  const findings: Array<UpstreamNameFinding> = [];

  if (NATIVE_FILE.test(path)) {
    source.split("\n").forEach((line, index) => {
      if (/^\s*(?:\/\/|\*|\/\*)/u.test(line)) return;
      for (const literal of line.matchAll(/"(?:[^"\\]|\\.)*"/gu)) {
        const found = finding(path, index + 1, literal[0].slice(1, -1));
        if (found !== undefined) findings.push(found);
      }
    });
    return findings;
  }

  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : /\.[mc]?js$/u.test(path)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS,
  );
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      const found = finding(path, line, node.text);
      if (found !== undefined) findings.push(found);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

/** Upstream names in tracked application and package sources outside the exceptions. */
export function findRepositoryUpstreamNames(repoRoot: string): ReadonlyArray<UpstreamNameFinding> {
  const paths = NodeChildProcess.execFileSync("git", ["ls-files", "-z", "--", ...SCANNED_ROOTS], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(
      (path) =>
        (SCRIPT_FILE.test(path) || NATIVE_FILE.test(path)) &&
        !SKIPPED_PATH.test(path) &&
        !isException(path),
    );
  return paths.flatMap((path) =>
    findUpstreamNames(path, NodeFS.readFileSync(NodePath.join(repoRoot, path), "utf8")),
  );
}
