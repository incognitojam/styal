// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import ts from "typescript-legacy";

/**
 * Upstream product names that must not reach styal users or agents. Upstream
 * intake brings new messages that use them, and nothing else notices. Bare
 * "T3" counts when used as a name ("T3 server", "T3's browser", "T3-owned");
 * T3 Chat, T3 Tools and the T3 Stack are other products and the company.
 */
const BARE_T3 = String.raw`\bT3(?! Chat\b| Tools\b| Stack\b)(?=[ '’]|-[a-z])`;
const UPSTREAM_NAME = new RegExp(String.raw`T3 Code|T3 Connect|t3\.codes|${BARE_T3}`, "u");

/** The fork's name for each upstream name. t3.codes has none yet, so it stays for a person. */
const renameText = (text: string) =>
  text
    .replaceAll("T3 Connect", "styal Link")
    .replaceAll("T3 Code", "styal")
    .replaceAll(new RegExp(BARE_T3, "gu"), "styal");

/**
 * Files whose strings may keep an upstream name, each with the reason. A path
 * ending in `/` covers every file below it.
 */
const UPSTREAM_NAMING_EXCEPTIONS: ReadonlyArray<{
  readonly path: string;
  readonly reason: string;
  /** Its strings reach agents or users through a styal rename, so tests quoting them see styal. */
  readonly renderedAsStyal?: true;
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
    renderedAsStyal: true,
  },
  {
    path: "packages/provider-core/src/server/orchestrationInstructions.ts",
    reason: "Instructions are delivered through renderStyalProductName.",
    renderedAsStyal: true,
  },
  {
    path: "packages/shared/src/htmlRender.ts",
    reason:
      "Its guides are part of MCP tool descriptions, advertised through renderStyalProductName.",
    renderedAsStyal: true,
  },
  {
    path: "packages/shared/src/t3McpToolPresentation.ts",
    reason: "Tool labels are rewritten by styalToolDefinition before display.",
    renderedAsStyal: true,
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
    renderedAsStyal: true,
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
  ":(glob)apps/mobile/plugins/**",
  "apps/mobile/app.config.ts",
  "scripts/build-desktop-artifact.ts",
];
const SCANNED_PATH =
  /^(?:apps\/[^/]+\/src\/|apps\/mobile\/modules\/|apps\/desktop\/gnome-extension\/|packages\/[^/]+\/src\/|apps\/mobile\/plugins\/|apps\/mobile\/app\.config\.ts$|scripts\/build-desktop-artifact\.ts$)/u;
const TEST_PATH = /\.test\./u;
const SKIPPED_PATH =
  /^apps\/marketing\/|\.fixture\.|\.testkit\.|\/testkit\/|\/fixtures\/|\/__tests__\/|\.d\.ts$/u;
const SCRIPT_FILE = /\.(?:ts|tsx|mts|js|mjs|cjs)$/u;
const NATIVE_FILE = /\.(?:kt|swift|java)$/u;

interface UpstreamNameFinding {
  readonly path: string;
  readonly line: number;
  readonly name: string;
  readonly text: string;
}

/** A renamed piece of string text, before and after. */
export interface UpstreamNameRename {
  readonly line: number;
  readonly before: string;
  readonly after: string;
}

const isException = (path: string) =>
  UPSTREAM_NAMING_EXCEPTIONS.some((exception) =>
    exception.path.endsWith("/") ? path.startsWith(exception.path) : path === exception.path,
  );

const isSource = (path: string) =>
  SCANNED_PATH.test(path) &&
  (SCRIPT_FILE.test(path) || NATIVE_FILE.test(path)) &&
  !SKIPPED_PATH.test(path);

/** Whether `naming:check` holds this file's strings to the fork's naming. */
export const isCheckedSource = (path: string) =>
  isSource(path) && !TEST_PATH.test(path) && !isException(path);

/** Whether this is a test whose assertions follow renamed source strings. */
export const isRenamedTest = (path: string) =>
  isSource(path) && TEST_PATH.test(path) && !isException(path);

interface StringSpan {
  /** Offsets of the span's raw source text, between its quotes or template delimiters. */
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly endLine: number;
  readonly text: string;
  /** The string names something rather than saying something, so renaming it changes behavior. */
  readonly identity: boolean;
}

/** Properties whose string values identify an app to the OS or to stored data. */
const IDENTITY_PROPERTY = /keychain|service|account|application|identity|bundle|appid|scheme/iu;
/** Channel product names such as "T3 Code (Beta)", which name apps, keychains and profiles. */
const CHANNEL_NAME = /^T3 Code \(/u;

/**
 * Whether a string is compared, used as a key, or given to an identity property: renaming one of
 * those changes what it matches, which a person has to decide.
 */
function isIdentityString(node: ts.Node, text: string): boolean {
  if (CHANNEL_NAME.test(text)) return true;
  const parent = node.parent;
  if (ts.isBinaryExpression(parent)) {
    return [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
    ].includes(parent.operatorToken.kind);
  }
  if (ts.isCaseClause(parent) || ts.isElementAccessExpression(parent)) return true;
  if (ts.isPropertyAssignment(parent)) {
    return parent.name === node || IDENTITY_PROPERTY.test(parent.name.getText());
  }
  return false;
}

/** The string literals, template text and JSX text of one source file that name upstream. */
function namedSpans(path: string, source: string): ReadonlyArray<StringSpan> {
  if (!UPSTREAM_NAME.test(source)) return [];
  const spans: Array<StringSpan> = [];

  if (NATIVE_FILE.test(path)) {
    let offset = 0;
    source.split("\n").forEach((line, index) => {
      if (!/^\s*(?:\/\/|\*|\/\*)/u.test(line)) {
        for (const literal of line.matchAll(/"(?:[^"\\]|\\.)*"/gu)) {
          const text = literal[0].slice(1, -1);
          const start = offset + literal.index + 1;
          if (UPSTREAM_NAME.test(text)) {
            spans.push({
              start,
              end: start + text.length,
              line: index + 1,
              endLine: index + 1,
              text,
              identity: false,
            });
          }
        }
      }
      offset += line.length + 1;
    });
    return spans;
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
    const jsx = ts.isJsxText(node);
    if (
      jsx ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      // Names never contain quotes, escapes or `${`, so matching the raw text between the
      // delimiters finds the same names as the cooked text.
      const start = node.getStart(file) + (jsx ? 0 : 1);
      const end =
        node.getEnd() - (jsx ? 0 : ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ? 2 : 1);
      if (UPSTREAM_NAME.test(node.text)) {
        spans.push({
          start,
          end,
          line: file.getLineAndCharacterOfPosition(start).line + 1,
          endLine: file.getLineAndCharacterOfPosition(end).line + 1,
          text: source.slice(start, end),
          identity: !jsx && isIdentityString(node, node.text),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return spans;
}

/** Upstream names in the string literals, template text and JSX text of one source file. */
export function findUpstreamNames(
  path: string,
  source: string,
): ReadonlyArray<UpstreamNameFinding> {
  return namedSpans(path, source).map(({ line, text }) => ({
    path,
    line,
    name: UPSTREAM_NAME.exec(text)![0],
    text: text.replace(/\s+/gu, " ").trim(),
  }));
}

function renameSpans(
  source: string,
  spans: ReadonlyArray<StringSpan>,
): { readonly text: string; readonly renames: ReadonlyArray<UpstreamNameRename> } {
  const renames: Array<UpstreamNameRename> = [];
  let text = source;
  for (const span of spans.toReversed()) {
    const after = renameText(span.text);
    if (after === span.text) continue;
    text = text.slice(0, span.start) + after + text.slice(span.end);
    renames.unshift({ line: span.line, before: span.text, after });
  }
  return { text, renames };
}

/** Line numbers to limit a rename to, such as the lines a pick adds; all lines when absent. */
type LineFilter = ReadonlySet<number> | undefined;

const onLines = (span: StringSpan, lines: LineFilter) => {
  if (lines === undefined) return true;
  for (let line = span.line; line <= span.endLine; line += 1) if (lines.has(line)) return true;
  return false;
};

/**
 * Renames upstream names in one source file's strings to the fork's names, except identity
 * strings, which stay for a person.
 */
export function renameUpstreamNames(path: string, source: string, lines?: LineFilter) {
  return renameSpans(
    source,
    namedSpans(path, source).filter((span) => !span.identity && onLines(span, lines)),
  );
}

/**
 * Renames a test's strings that quote a renamed source string, so assertions follow the source.
 * A short string that only appears inside a renamed one, such as a project titled "T3 Code", is
 * test data and stays.
 */
export function renameTestStrings(
  path: string,
  source: string,
  renamed: ReadonlyArray<string>,
  lines?: LineFilter,
) {
  const quotes = (text: string) =>
    renamed.some(
      (before) =>
        text.includes(before) ||
        (before.includes(text) && text.length >= UPSTREAM_NAME.exec(text)![0].length + 12),
    );
  return renameSpans(
    source,
    namedSpans(path, source).filter(
      (span) => !span.identity && onLines(span, lines) && quotes(span.text),
    ),
  );
}

const trackedFiles = (repoRoot: string) =>
  NodeChildProcess.execFileSync("git", ["ls-files", "-z", "--", ...SCANNED_ROOTS], {
    cwd: repoRoot,
    encoding: "utf8",
  }).split("\0");

/** Upstream names in tracked application and package sources outside the exceptions. */
export function findRepositoryUpstreamNames(repoRoot: string): ReadonlyArray<UpstreamNameFinding> {
  return trackedFiles(repoRoot)
    .filter(isCheckedSource)
    .flatMap((path) =>
      findUpstreamNames(path, NodeFS.readFileSync(NodePath.join(repoRoot, path), "utf8")),
    );
}

/** Strings in files whose text reaches readers through a styal rename, which tests quote as styal. */
function renderedAsStyalStrings(repoRoot: string): ReadonlyArray<string> {
  const rendered = UPSTREAM_NAMING_EXCEPTIONS.filter((exception) => exception.renderedAsStyal);
  return trackedFiles(repoRoot)
    .filter(
      (path) =>
        !TEST_PATH.test(path) &&
        rendered.some((exception) =>
          exception.path.endsWith("/") ? path.startsWith(exception.path) : path === exception.path,
        ),
    )
    .flatMap((path) =>
      namedSpans(path, NodeFS.readFileSync(NodePath.join(repoRoot, path), "utf8")).map(
        ({ text }) => text,
      ),
    );
}

/**
 * Renames upstream names in every tracked source, or only on the given lines of the given files,
 * and in the tests that quote the renamed strings, and returns the renames by file.
 */
export function renameRepositoryUpstreamNames(
  repoRoot: string,
  addedLines?: ReadonlyMap<string, ReadonlySet<number>>,
): ReadonlyMap<string, ReadonlyArray<UpstreamNameRename>> {
  const paths = addedLines === undefined ? trackedFiles(repoRoot) : [...addedLines.keys()];
  const renamesByPath = new Map<string, ReadonlyArray<UpstreamNameRename>>();
  const rewrite = (
    path: string,
    rename: (source: string) => ReturnType<typeof renameUpstreamNames>,
  ) => {
    const absolute = NodePath.join(repoRoot, path);
    if (!NodeFS.existsSync(absolute)) return;
    const result = rename(NodeFS.readFileSync(absolute, "utf8"));
    if (result.renames.length === 0) return;
    NodeFS.writeFileSync(absolute, result.text);
    renamesByPath.set(path, result.renames);
  };
  for (const path of paths.filter(isCheckedSource)) {
    rewrite(path, (source) => renameUpstreamNames(path, source, addedLines?.get(path)));
  }
  const tests = paths.filter(isRenamedTest);
  if (tests.length > 0) {
    const renamed = [
      ...[...renamesByPath.values()].flat().map(({ before }) => before),
      ...renderedAsStyalStrings(repoRoot),
    ];
    for (const path of tests) {
      rewrite(path, (source) => renameTestStrings(path, source, renamed, addedLines?.get(path)));
    }
  }
  return renamesByPath;
}

/** Whether a line names upstream's product, for text outside parsed sources such as user guides. */
export const namesUpstreamProductText = (text: string) => UPSTREAM_NAME.test(text);

/** The names a file's renames replaced, as "from -> to", for adaptation notes. */
export function upstreamNamesRenamed(
  renames: ReadonlyArray<UpstreamNameRename>,
): ReadonlyArray<string> {
  const found = new Set<string>();
  for (const { before } of renames) {
    if (before.includes("T3 Connect")) found.add("T3 Connect -> styal Link");
    if (before.includes("T3 Code")) found.add("T3 Code -> styal");
    if (new RegExp(BARE_T3, "u").test(before.replaceAll(/T3 Code|T3 Connect/gu, ""))) {
      found.add("T3 -> styal");
    }
  }
  return [...found];
}
