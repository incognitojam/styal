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
  // Each form also appears JSON-escaped up to three levels deep, as in a JSON string
  // logged inside another JSON string.
  const variants = secrets
    .filter((secret) => secret.length >= 8)
    .flatMap((secret) => {
      const url = encodeURIComponent(secret);
      const base64 = [0, 1, 2].flatMap((shift) => {
        // Shifted encodings drop the first group, which also encodes the bytes before the key.
        const form = Buffer.concat([Buffer.alloc(shift), Buffer.from(secret)])
          .toString("base64")
          .slice(shift === 0 ? 0 : 4);
        return [form, form.replace(/=+$/, "")].flatMap((padded) => [
          padded,
          padded.replaceAll("+", "-").replaceAll("/", "_"),
        ]);
      });
      return [
        secret,
        url,
        url.replace(/%[0-9A-F]{2}/g, (match) => match.toLowerCase()),
        new URLSearchParams({ key: secret }).toString().slice(4),
        // Some form encoders use '+' for spaces while leaving literal plus signs intact.
        url.replaceAll("%20", "+"),
        url.replaceAll("%2B", "+"),
        ...base64,
        Array.from(secret, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join(
          "",
        ),
      ].flatMap((form) => {
        const nested = [form];
        for (let depth = 1; depth <= 3; depth++)
          nested.push(JSON.stringify(nested.at(-1)).slice(1, -1));
        return nested;
      });
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
  /** Visits each character with `\uXXXX` escapes decoded, skipping the gaps exact matching allows. */
  const scan = (input: string, visit: (char: string, start: number, end: number) => void) => {
    for (let index = 0; index < input.length;) {
      const start = index;
      let char = input[index++]!;
      if (char === "\\" && /^[nrt]$/.test(input[index] ?? "")) {
        index += 1;
        continue;
      }
      const escaped =
        char === "\\" ? /^u([0-9a-fA-F]{4})/.exec(input.slice(index, index + 5)) : null;
      if (escaped) {
        char = String.fromCharCode(Number.parseInt(escaped[1]!, 16));
        index += 5;
      }
      if (char.trim() !== "") visit(char, start, index);
    }
  };
  // Any 12 characters of a form are redacted, so a key truncated or split anywhere leaves
  // at most 11 characters of it. Forms are read the same way as the text they are matched in.
  const fragment = 12;
  const grams = new Set(
    variants.flatMap((form) => {
      let read = "";
      scan(form, (char) => {
        read += char;
      });
      read = read.replace(/=+$/, "");
      return Array.from({ length: Math.max(0, read.length - fragment + 1) }, (_, start) =>
        read.slice(start, start + fragment),
      );
    }),
  );
  const partial = (input: string) => {
    if (grams.size === 0) return input;
    const spans: Array<[number, number]> = [];
    const starts: number[] = [];
    let window = "";
    scan(input, (char, start, end) => {
      starts.push(start);
      if (starts.length > fragment) starts.shift();
      window = (window + char).slice(-fragment);
      if (window.length < fragment || !grams.has(window)) return;
      while (input[end] === "=") end += 1;
      const last = spans.at(-1);
      if (last && last[1] >= starts[0]!) last[1] = end;
      else spans.push([starts[0]!, end]);
    });
    let output = "";
    let cursor = 0;
    for (const [from, to] of spans) {
      output += `${input.slice(cursor, from)}[redacted]`;
      cursor = to;
    }
    return output + input.slice(cursor);
  };
  const text = (input: string) => {
    for (const pattern of exact) input = input.replace(pattern, "[redacted]");
    // Patterns first: a token sharing a prefix with the key must still match whole.
    return partial(
      input
        .replace(/\b(?:sk-[a-zA-Z0-9_-]{8,}|ghp_[a-zA-Z0-9]{8,})/g, "[redacted]")
        .replace(/\bBearer\s+[^\s"'\\,;]+/gi, "Bearer [redacted]")
        .replace(
          /((?:api[_-]?key|access[_-]?token|token|secret|authorization)["'\\\s:=]+)[a-zA-Z0-9+/_=-]{24,}/gi,
          "$1[redacted]",
        ),
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
    if (!target) throw new Error("Usage: canary-redaction.ts FILE_OR_DIRECTORY");
    if (NodeFS.statSync(target).isDirectory()) {
      for (const entry of NodeFS.readdirSync(target, { withFileTypes: true }))
        if (entry.isFile() && /\.(?:json|ndjson|log)$/.test(entry.name))
          redactFile(NodePath.join(target, entry.name));
    } else redactFile(target);
  } catch {
    console.error("Canary data sanitization failed; result withheld.");
    process.exitCode = 1;
  }
}
