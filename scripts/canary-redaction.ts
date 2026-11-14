// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Dependency-free sanitizer also runs against release-tag verifier files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function redactCanary<T>(value: T, secrets: ReadonlyArray<string> = []): T {
  const gaps = String.raw`(?:\s|\\[nrt]|\\u000[aAdD9])*`;
  const exact = secrets.filter(Boolean).map(
    (secret) =>
      new RegExp(
        Array.from(secret)
          .map(
            (char) =>
              `(?:${RegExp.escape(char)}|\\\\u${char.charCodeAt(0).toString(16).padStart(4, "0")})`,
          )
          .join(gaps),
        "g",
      ),
  );
  const text = (input: string) => {
    for (const pattern of exact) input = input.replace(pattern, "[redacted]");
    return input
      .replace(/\b(?:sk-[a-zA-Z0-9_-]{8,}|ghp_[a-zA-Z0-9]{8,})/g, "[redacted]")
      .replace(/\bBearer\s+[^\s"'\\,;]+/gi, "Bearer [redacted]")
      .replace(
        /((?:api[_-]?key|access[_-]?token|token|secret|authorization)["'\\\s:=]+)[a-zA-Z0-9+/_=-]{24,}/gi,
        "$1[redacted]",
      );
  };
  const visit = (item: unknown, key = ""): unknown => {
    if (typeof item === "string") {
      const clean = text(item);
      return /(?:api[_-]?key|access[_-]?token|token|secret|authorization)/i.test(key)
        ? clean.replace(/[a-zA-Z0-9+/_=-]{24,}/g, "[redacted]")
        : clean;
    }
    if (Array.isArray(item)) return item.map((entry) => visit(entry));
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [text(key), visit(entry, key)]),
      );
    return item;
  };
  return visit(value) as T;
}

if (import.meta.main) {
  const target = process.argv[2];
  if (!target) throw new Error("Usage: canary-redaction.ts FILE_OR_DIRECTORY");
  const files = NodeFS.statSync(target).isDirectory()
    ? NodeFS.readdirSync(target)
        .filter((name) => name.endsWith(".json"))
        .map((name) => NodePath.join(target, name))
    : [target];
  for (const file of files) {
    const clean = redactCanary(JSON.parse(NodeFS.readFileSync(file, "utf8")), [
      process.env.API_KEY ?? "",
    ]);
    NodeFS.writeFileSync(file, `${JSON.stringify(clean)}\n`);
  }
}
