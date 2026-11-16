// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalConsole:off -- Dependency-free sanitizer also runs against release-tag verifier files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function redactCanary<T>(
  value: T,
  secrets: ReadonlyArray<string> = [],
  warn: (message: string) => void = (message) => console.warn(message),
): T {
  const gaps = String.raw`(?:\s|\\[nrt]|\\u000[aAdD9])*`;
  if (secrets.some((secret) => secret.length > 0 && secret.length < 8))
    warn("Ignoring API_KEY shorter than 8 characters for exact redaction.");
  const variants = secrets
    .filter((secret) => secret.length >= 8)
    .flatMap((secret) => {
      const encoded = Buffer.from(secret);
      const url = encodeURIComponent(secret);
      return [
        secret,
        url,
        url.replace(/%[0-9A-F]{2}/g, (match) => match.toLowerCase()),
        new URLSearchParams({ key: secret }).toString().slice(4),
        // Some form encoders use '+' for spaces while leaving literal plus signs intact.
        url.replaceAll("%20", "+"),
        url.replaceAll("%2B", "+"),
        encoded.toString("base64"),
        encoded.toString("base64").replace(/=+$/, ""),
        encoded.toString("base64url"),
        encoded.toString("base64").replaceAll("+", "-").replaceAll("/", "_"),
        JSON.stringify(secret).slice(1, -1),
      ];
    });
  const exact = [...new Set(variants)]
    .sort((a, b) => b.length - a.length)
    .map(
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
  let warned = false;
  const redact = <T>(value: T) =>
    redactCanary(value, [process.env.API_KEY ?? ""], (message) => {
      if (!warned) console.warn(message);
      warned = true;
    });
  const redactFile = (file: string) => {
    const input = NodeFS.readFileSync(file, "utf8");
    const output = file.endsWith(".json")
      ? `${JSON.stringify(redact(JSON.parse(input)), null, 2)}\n`
      : file.endsWith(".ndjson")
        ? redact(
            input
              .split("\n")
              .filter((line) => line.trim() !== "")
              .map((line): unknown => JSON.parse(line)),
          )
            .map((event) => `${JSON.stringify(event)}\n`)
            .join("")
        : redact(input);
    NodeFS.writeFileSync(file, output);
  };
  try {
    const target = process.argv[2];
    if (!target) throw new Error("Usage: canary-redaction.ts [--print] FILE_OR_DIRECTORY");
    if (target === "--print") {
      const file = process.argv[3]!;
      if (NodeFS.statSync(file).size > 16 * 1024 * 1024) {
        console.log("Verifier output withheld: it is larger than 16 MiB.");
        process.exitCode = 1;
      } else process.stdout.write(redact(NodeFS.readFileSync(file, "utf8")));
    } else if (NodeFS.statSync(target).isDirectory()) {
      for (const entry of NodeFS.readdirSync(target, { withFileTypes: true }))
        if (entry.isFile() && /\.(?:json|ndjson|log)$/.test(entry.name))
          redactFile(NodePath.join(target, entry.name));
    } else redactFile(target);
  } catch {
    console.error("Canary data sanitization failed; result withheld.");
    process.exitCode = 1;
  }
}
