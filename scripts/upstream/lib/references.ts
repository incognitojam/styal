// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fixes for fork code that still names what an upstream commit renamed or moved, driven by the
 * TypeScript errors those references produce.
 */

import * as NodePath from "node:path";

export type ReferenceError =
  /** `Cannot find name 'x'`, with or without a suggestion. */
  | { readonly kind: "name"; readonly file: string; readonly name: string }
  /** `Module '"m"' has no exported member 'x'`. */
  | {
      readonly kind: "export";
      readonly file: string;
      readonly name: string;
      readonly module: string;
    }
  /** `Property 'x' does not exist on type 'typeof import("…")'`: a namespace import's member. */
  | { readonly kind: "member"; readonly file: string; readonly name: string }
  /** `Cannot find module 'm'`. */
  | { readonly kind: "module"; readonly file: string; readonly module: string };

/** Reference errors in `tsc` output, with files relative to the repository root. */
export function parseReferenceErrors(
  output: string,
  packageDirectory: string,
): ReadonlyArray<ReferenceError> {
  const errors: Array<ReferenceError> = [];
  for (const line of output.split("\n")) {
    const location = /^(.+?)\(\d+,\d+\): error TS(\d+): (.*)$/u.exec(line);
    if (!location) continue;
    const file = NodePath.posix.normalize(NodePath.posix.join(packageDirectory, location[1]!));
    const [, , code, message] = location as unknown as [string, string, string, string];
    let match: RegExpExecArray | null;
    if (
      (code === "2304" || code === "2552") &&
      (match = /^Cannot find name '([^']+)'/u.exec(message))
    ) {
      errors.push({ kind: "name", file, name: match[1]! });
    } else if (
      (code === "2305" || code === "2724") &&
      (match = /^(?:Module )?'"([^"]+)"' has no exported member (?:named )?'([^']+)'/u.exec(
        message,
      ))
    ) {
      errors.push({ kind: "export", file, module: match[1]!, name: match[2]! });
    } else if (
      code === "2339" &&
      (match = /^Property '([^']+)' does not exist on type 'typeof import\(/u.exec(message))
    ) {
      errors.push({ kind: "member", file, name: match[1]! });
    } else if (code === "2307" && (match = /^Cannot find module '([^']+)'/u.exec(message))) {
      errors.push({ kind: "module", file, module: match[1]! });
    }
  }
  return errors;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Renames every whole-identifier use of `from`, including property access such as `X.from`. */
export function renameIdentifier(text: string, from: string, to: string): string {
  return text.replace(new RegExp(`(?<![\\w$])${escapeRegExp(from)}(?![\\w$])`, "gu"), to);
}

/**
 * Replaces a named import of `name` from `specifier` with a namespace import, and its uses with
 * `Alias.member`. Upstream renames many exports to a bare `layer`, which cannot be imported by
 * name next to another module's `layer`.
 */
export function useNamespaceImport(
  text: string,
  input: {
    readonly specifier: string;
    readonly name: string;
    readonly alias: string;
    readonly member: string;
  },
): string {
  const quoted = escapeRegExp(input.specifier);
  const importPattern = new RegExp(
    `import\\s*(type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${quoted}["'];?`,
    "u",
  );
  const match = importPattern.exec(text);
  if (!match) return text;
  const specifiers = match[2]!
    .split(",")
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier !== "");
  const remaining = specifiers.filter(
    (specifier) => specifier.replace(/^type\s+/u, "").split(/\s+as\s+/u)[0] !== input.name,
  );
  const namespaceImport = `import * as ${input.alias} from "${input.specifier}";`;
  const replacement =
    remaining.length === 0
      ? namespaceImport
      : `import ${match[1] ?? ""}{ ${remaining.join(", ")} } from "${input.specifier}";\n${namespaceImport}`;
  const body = text.slice(0, match.index) + "\u0000" + text.slice(match.index + match[0].length);
  return renameIdentifier(body, input.name, `${input.alias}.${input.member}`).replace(
    "\u0000",
    replacement,
  );
}

/** A namespace alias for a module path, such as `OrchestrationHttp` for `orchestration-v2/http.ts`. */
export function namespaceAlias(specifier: string): string {
  const parts = specifier
    .replace(/\.[cm]?tsx?$/u, "")
    .split("/")
    .filter((part) => part !== "." && part !== "..");
  const pascal = (part: string) =>
    part
      .split(/[^A-Za-z0-9]+/u)
      .filter((word) => word !== "")
      .map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join("");
  const last = pascal(parts.at(-1) ?? "Module");
  // A generic file name such as `http.ts` takes its folder for context.
  return /^(Http|Index|Layer|Service|Types?)$/u.test(last) && parts.length > 1
    ? `${pascal(parts.at(-2)!)}${last}`
    : last;
}

/** The import specifier for `target` from `file`, both relative to the repository root. */
export function relativeSpecifier(file: string, target: string): string {
  const relative = NodePath.posix.relative(NodePath.posix.dirname(file), target);
  return relative.startsWith(".") ? relative : `./${relative}`;
}
