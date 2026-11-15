// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off globalTimers:off - Deploy-step script that runs with node and only Node built-ins.
/**
 * Copies a web build's assets into the bucket the Worker falls back to for files a newer build
 * removed. Run after each deploy: `node scripts/sync-old-assets.ts <bucket> <dist directory>`.
 *
 * The bucket deletes objects 30 days after upload, so a file still in the build is uploaded again
 * once its copy is a week old.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const REFRESH_AFTER_MS = 7 * 86_400_000;
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 8;
const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".glb": "model/gltf-binary",
};

const [bucket, distDir] = process.argv.slice(2);
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!bucket || !distDir || !accountId || !token) {
  console.error(
    "Usage: node scripts/sync-old-assets.ts <bucket> <dist directory>, with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN set.",
  );
  process.exit(1);
}

const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects`;
const authorization = { Authorization: `Bearer ${token}` };

// The API rate-limits bursts with HTTP 429 or by resetting HTTP/2 streams.
async function request(description: string, url: string | URL, init?: RequestInit) {
  for (let attempt = 1; ; attempt++) {
    const outcome = await fetch(url, init).then(
      async (response) =>
        response.ok
          ? { response }
          : {
              retry: response.status === 429 || response.status >= 500,
              retryAfter: Number(response.headers.get("Retry-After")),
              detail: `HTTP ${response.status} ${await response.text()}`,
            },
      (error: unknown) => ({ retry: true, retryAfter: Number.NaN, detail: String(error) }),
    );
    if ("response" in outcome) return outcome.response;
    if (!outcome.retry || attempt === MAX_ATTEMPTS) {
      throw new Error(`${description} failed: ${outcome.detail}`);
    }
    const delaySeconds = outcome.retryAfter > 0 ? outcome.retryAfter : 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
  }
}

async function listUploaded(): Promise<Map<string, number>> {
  const uploaded = new Map<string, number>();
  let cursor: string | undefined;
  do {
    const url = new URL(api);
    url.searchParams.set("prefix", "assets/");
    url.searchParams.set("per_page", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await request(`Listing ${bucket}`, url, { headers: authorization });
    const body = (await response.json()) as {
      result: { key: string; last_modified: string }[];
      result_info?: { cursor?: string; is_truncated?: boolean | string };
    };
    for (const object of body.result) uploaded.set(object.key, Date.parse(object.last_modified));
    const truncated = String(body.result_info?.is_truncated) === "true";
    cursor = truncated ? body.result_info?.cursor : undefined;
  } while (cursor);
  return uploaded;
}

async function upload(key: string, file: string) {
  const contentType =
    CONTENT_TYPES[NodePath.extname(file).toLowerCase()] ?? "application/octet-stream";
  await request(`Uploading ${key}`, `${api}/${key.split("/").map(encodeURIComponent).join("/")}`, {
    method: "PUT",
    headers: { ...authorization, "Content-Type": contentType },
    body: await NodeFSP.readFile(file),
  });
}

const assetsDir = NodePath.join(distDir, "assets");
const files: { key: string; file: string }[] = [];
for (const entry of await NodeFSP.readdir(assetsDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || entry.name.endsWith(".map")) continue;
  const file = NodePath.join(entry.parentPath, entry.name);
  files.push({
    key: `assets/${NodePath.relative(assetsDir, file).split(NodePath.sep).join("/")}`,
    file,
  });
}
const uploaded = await listUploaded();
const now = Date.now();
const pending = files.filter(({ key }) => {
  const uploadedAt = uploaded.get(key);
  return uploadedAt === undefined || now - uploadedAt > REFRESH_AFTER_MS;
});

let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < pending.length) {
      const { key, file } = pending[next++]!;
      await upload(key, file);
    }
  }),
);
console.log(`Uploaded ${pending.length} of ${files.length} assets to ${bucket}.`);
