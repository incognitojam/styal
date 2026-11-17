// @effect-diagnostics nodeBuiltinImport:off - Reads the build/audit source graph without executing it.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import ts from "typescript-legacy";

export function importedBuildInputs(repoRoot: string, entries?: ReadonlyArray<string>) {
  const files =
    entries ??
    NodeChildProcess.execFileSync("git", ["ls-files", "-z", "--", ".", ":(exclude).repos"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean);
  const roots =
    entries ??
    files.filter(
      (file) =>
        /\.[cm]?[jt]sx?$/u.test(file) &&
        (file.startsWith("scripts/") ||
          file.includes("/scripts/") ||
          /\.config\.[cm]?[jt]s$/u.test(file) ||
          file.startsWith("apps/mobile/plugins/")),
    );
  const workspaceDirectories = files
    .filter((file) => NodePath.basename(file) === "package.json")
    .map((file) => NodePath.dirname(NodePath.join(repoRoot, file)));
  const require = NodeModule.createRequire(NodePath.join(repoRoot, "package.json"));
  // Installed launchers refer to these outputs; follow their checked-in source instead.
  const packagedSources: Readonly<Record<string, string>> = {
    "scripts/bin/styal.mjs": "scripts/npm-launcher/styal.mjs",
    "apps/desktop/dist-electron/boot.cjs": "apps/desktop/src/boot.ts",
    "apps/desktop/src/compileCache.cjs": "apps/desktop/src/compileCache.ts",
    "apps/desktop/src/main.cjs": "apps/desktop/src/main.ts",
  };
  const configurations = new Map<string, ts.CompilerOptions>();
  const defaultOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler };
  const resolutionCaches = new Map<ts.CompilerOptions, ts.ModuleResolutionCache>();
  const optionsFor = (file: string) => {
    const config = ts.findConfigFile(NodePath.dirname(file), ts.sys.fileExists);
    if (config && !configurations.has(config)) {
      const json = ts.readConfigFile(config, ts.sys.readFile);
      if (json.error)
        throw new Error(
          `Cannot parse ${config}: ${ts.flattenDiagnosticMessageText(json.error.messageText, " ")}`,
        );
      const parsed = ts.parseJsonConfigFileContent(
        json.config,
        { ...ts.sys, readDirectory: () => [] },
        NodePath.dirname(config),
      );
      const invalid = parsed.errors.filter((error) => error.code !== 18003 && error.code !== 18002);
      if (invalid.length)
        throw new Error(
          `Cannot resolve config ${config}: ${invalid.map((error) => ts.flattenDiagnosticMessageText(error.messageText, " ")).join("; ")}`,
        );
      configurations.set(config, { ...parsed.options, ...defaultOptions });
    }
    return config ? configurations.get(config)! : defaultOptions;
  };
  const pending = roots.map((file) => NodePath.join(repoRoot, file));
  const seen = new Set<string>();
  const protectedPaths = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    if (!NodeFS.existsSync(file)) throw new Error(`Cannot resolve source ${file}`);
    seen.add(file);
    const relative = NodePath.relative(repoRoot, file).split(NodePath.sep).join("/");
    if (relative.startsWith("../")) throw new Error(`Build import escapes repository: ${file}`);
    if (relative.includes("node_modules/") || relative.startsWith(".repos/")) continue;
    if (
      /^(?:apps\/mobile\/src|packages\/(?:shared|client-runtime|contracts)\/src)\//u.test(relative)
    )
      protectedPaths.add(relative);
    if (!/\.[cm]?[jt]sx?$/u.test(file)) continue;
    const source = ts.createSourceFile(
      file,
      NodeFS.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const diagnostics = (
      source as ts.SourceFile & { parseDiagnostics: ReadonlyArray<ts.Diagnostic> }
    ).parseDiagnostics;
    if (diagnostics.length)
      throw new Error(
        `Cannot parse ${relative}: ${diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")).join("; ")}`,
      );
    const visit = (node: ts.Node): void => {
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
            ? node.moduleReference.expression
            : ts.isCallExpression(node) &&
                (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                  (ts.isIdentifier(node.expression) && node.expression.text === "require"))
              ? node.arguments[0]
              : undefined;
      if (specifier && ts.isStringLiteralLike(specifier)) {
        if (NodeModule.isBuiltin(specifier.text)) return;
        const options = optionsFor(file);
        let cache = resolutionCaches.get(options);
        if (!cache) {
          cache = ts.createModuleResolutionCache(repoRoot, (path) => path, options);
          resolutionCaches.set(options, cache);
        }
        const resolved = ts.resolveModuleName(
          specifier.text,
          file,
          options,
          ts.sys,
          cache,
        ).resolvedModule;
        const packaged = specifier.text.startsWith(".")
          ? packagedSources[
              NodePath.relative(repoRoot, NodePath.resolve(NodePath.dirname(file), specifier.text))
                .split(NodePath.sep)
                .join("/")
            ]
          : undefined;
        let target = packaged ? NodePath.join(repoRoot, packaged) : resolved?.resolvedFileName;
        if (!target && specifier.text.startsWith(".") && /\?(?:raw|url)$/u.test(specifier.text)) {
          const asset = NodePath.resolve(
            NodePath.dirname(file),
            specifier.text.replace(/\?(?:raw|url)$/u, ""),
          );
          if (NodeFS.statSync(asset).isFile()) target = asset;
        }
        if (!target && !specifier.text.startsWith(".")) {
          try {
            target = require.resolve(specifier.text, { paths: workspaceDirectories });
          } catch {
            throw new Error(`Cannot resolve build import ${specifier.text} from ${relative}`);
          }
        }
        if (!target)
          throw new Error(`Cannot resolve build import ${specifier.text} from ${relative}`);
        target = NodeFS.realpathSync(target);
        if (!target.includes(`${NodePath.sep}node_modules${NodePath.sep}`)) pending.push(target);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return protectedPaths;
}
