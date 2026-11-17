// @effect-diagnostics nodeBuiltinImport:off -- Audit Node filesystem calls in runtime source files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import ts from "typescript-legacy";
import { expect, it } from "vite-plus/test";

function recursiveNodeDeletes(text: string) {
  const source = ts.createSourceFile("source.ts", text, ts.ScriptTarget.Latest, true);
  const namespaces = new Set<string>();
  const functions = new Set<string>();
  const isFs = (value: string) =>
    value === "node:fs" ||
    value === "node:fs/promises" ||
    value === "fs" ||
    value === "fs/promises";
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !isFs(statement.moduleSpecifier.text)
    )
      continue;
    const clause = statement.importClause;
    if (clause?.name) namespaces.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings))
      for (const binding of bindings.elements)
        if (
          ["rm", "rmSync", "rmdir", "rmdirSync"].includes(
            (binding.propertyName ?? binding.name).text,
          )
        )
          functions.add(binding.name.text);
  }
  const fromFs = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && namespaces.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === "promises" &&
      fromFs(node.expression)) ||
    (ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      !!node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      isFs(node.arguments[0].text));
  const calls: number[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      fromFs(node.initializer)
    )
      namespaces.add(node.name.text);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const deletion =
        (ts.isIdentifier(callee) && functions.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) &&
          ["rm", "rmSync", "rmdir", "rmdirSync"].includes(callee.name.text) &&
          fromFs(callee.expression));
      const options = node.arguments[1];
      if (
        deletion &&
        options &&
        ts.isObjectLiteralExpression(options) &&
        options.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText(source).replaceAll(/["']/g, "") === "recursive" &&
            property.initializer.kind !== ts.SyntaxKind.FalseKeyword,
        )
      )
        calls.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(source) === "String.raw") {
      const template = node.template;
      const script = ts.isNoSubstitutionTemplateLiteral(template)
        ? template.text
        : template.head.text +
          template.templateSpans.map((span) => `0${span.literal.text}`).join("");
      if (recursiveNodeDeletes(script).length)
        calls.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

it("recognizes recursive Node deletion through namespaces, promises, named imports, and require", () => {
  expect(
    recursiveNodeDeletes(`
    import * as fs from 'node:fs';
    import { rm as remove } from 'node:fs/promises';
    fs.rmSync(root, { recursive: true });
    fs.promises.rm(root, { recursive: true });
    remove(root, { recursive: true });
    require('node:fs').rm(root, { recursive: true });
    fs.rmSync(file, { force: true });
    fs.rmSync(file, { recursive: false });
    const legacy = require('node:fs');
    legacy.rmSync(root, { recursive: true });
  `),
  ).toEqual([4, 5, 6, 7, 11]);
});

it("routes runtime recursive deletion through the injectable filesystem instead of node:fs", () => {
  const root = NodePath.resolve(import.meta.dirname, "..");
  const roots = [
    "apps/server/src",
    ...NodeFS.readdirSync(NodePath.join(root, "packages")).map((name) => `packages/${name}/src`),
  ];
  const violations: string[] = [];
  for (const directory of roots) {
    const absolute = NodePath.join(root, directory);
    if (!NodeFS.existsSync(absolute)) continue;
    for (const entry of NodeFS.readdirSync(absolute, { recursive: true, encoding: "utf8" })) {
      const relative = `${directory}/${entry.split(NodePath.sep).join("/")}`;
      if (
        !/\.[cm]?[jt]sx?$/.test(relative) ||
        /\.(?:test|testkit)\.|\/(?:testing|testkit|testUtils)\//.test(relative)
      )
        continue;
      // This script is exclusively executed by a remote Node runtime over SSH.
      if (relative === "apps/server/src/device/sshDeviceScript.ts") continue;
      const text = NodeFS.readFileSync(NodePath.join(absolute, entry), "utf8");
      if (!/["'](?:node:)?fs(?:\/promises)?["']/.test(text)) continue;
      for (const line of recursiveNodeDeletes(text)) violations.push(`${relative}:${line}`);
    }
  }
  expect(violations).toEqual([]);
});
