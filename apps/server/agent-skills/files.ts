// @effect-diagnostics-next-line nodeBuiltinImport:off -- Source assets are read here only in development and by the bundler.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Resolves source assets before they are embedded in the server bundle.
import * as NodePath from "node:path";

const root = import.meta.dirname;
const names = NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(md|json)$/.test(entry.name))
  .map((entry) => NodePath.relative(root, NodePath.join(entry.parentPath, entry.name)));

export const skillFiles = Object.fromEntries(
  names.map((name) => [
    name.replaceAll("\\", "/"),
    NodeFS.readFileSync(NodePath.join(root, name), "utf8"),
  ]),
);
