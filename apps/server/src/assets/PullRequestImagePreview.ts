import * as NodeModule from "node:module";
import type { SourceControlImagePreviewError } from "@t3tools/source-control-core/server/driver";
import type { AssetImagePreview } from "@t3tools/contracts";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as ServerConfig from "../config.ts";

export class ImagePreviewError extends Schema.TaggedError<ImagePreviewError>()(
  "ImagePreviewError",
  {},
) {
  override get message() {
    return "Image preview unavailable. Open the original image.";
  }
}

type Source = { readonly bytes: Uint8Array; readonly contentType: string };
type Derivative = Source & { readonly expiresAt: number };
type Input = {
  readonly identity: string;
  readonly preview: AssetImagePreview;
  readonly fetch: Effect.Effect<Source, SourceControlImagePreviewError>;
};

export class PullRequestImagePreview extends Context.Service<
  PullRequestImagePreview,
  {
    readonly read: (input: Input) => Effect.Effect<Derivative, ImagePreviewError>;
  }
>()("@styal/cli/assets/PullRequestImagePreview") {}

const requireSharp = NodeModule.createRequire(import.meta.url);

const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const digest = yield* Digest.Digest;
  const directory = path.join(config.stateDir, "cache", "pr-image-previews", "v1");
  const lock = yield* Semaphore.make(1);
  const active = new Map<string, Effect.Effect<Derivative, ImagePreviewError>>();
  const sources = new Map<string, { fetch: Input["fetch"]; users: number }>();
  const entries = new Map<string, { size: number; expires: number; used: number }>();
  const remove = Effect.fn("PullRequestImagePreview.remove")(function* (key: string) {
    const removed = yield* fs
      .remove(path.join(directory, key), { force: true })
      .pipe(Effect.isSuccess);
    if (removed) entries.delete(key);
    return removed;
  });
  const prune = Effect.fn("PullRequestImagePreview.prune")(function* (reserve = 0) {
    const now = yield* Clock.currentTimeMillis;
    let size = [...entries.values()].reduce((sum, entry) => sum + entry.size, 0);
    for (const [key, entry] of [...entries].sort((a, b) => a[1].used - b[1].used)) {
      if (entry.expires <= now || size + reserve > 256 * 1024 * 1024 || entries.size >= 2000) {
        if (yield* remove(key)) size -= entry.size;
      }
    }
    return size + reserve <= 256 * 1024 * 1024 && entries.size < 2000;
  });
  yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.ignore);
  const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
  for (const name of names) {
    if (!/^[a-f0-9]{64}$/.test(name)) {
      if (/^[a-f0-9]{64}\.tmp$/.test(name))
        yield* fs.remove(path.join(directory, name)).pipe(Effect.ignore);
      continue;
    }
    const info = yield* fs.stat(path.join(directory, name)).pipe(Effect.option);
    if (info._tag === "Some")
      entries.set(name, { size: Number(info.value.size), expires: 0, used: 0 });
    if (
      info._tag === "None" ||
      info.value.type !== "File" ||
      info.value.size > 4 * 1024 * 1024 + 8
    ) {
      yield* remove(name);
      continue;
    }
    const stored = yield* fs.readFile(path.join(directory, name)).pipe(Effect.option);
    if (stored._tag === "Some" && stored.value.length >= 8) {
      const expires = Buffer.from(stored.value).readDoubleBE(0);
      if (Number.isFinite(expires))
        entries.set(name, { size: stored.value.length, expires, used: expires - 300_000 });
      else yield* remove(name);
    } else yield* remove(name);
  }
  yield* prune();
  yield* prune().pipe(
    lock.withPermit,
    Effect.repeat(Schedule.spaced("5 minutes")),
    Effect.forkScoped,
  );

  const read = Effect.fn("PullRequestImagePreview.read")(function* (input: Input) {
    const key = Hex.encode(
      yield* digest.digest(
        Digest.sha256,
        new TextEncoder().encode(
          `${input.identity.length}:${input.identity}:${input.preview.width}:webp-lossless-v2`,
        ),
      ),
    );
    const now = yield* Clock.currentTimeMillis;
    const entry = entries.get(key);
    if (entry && entry.expires > now) {
      const bytes = yield* fs.readFile(path.join(directory, key)).pipe(Effect.option);
      if (bytes._tag === "Some") {
        entry.used = now;
        return {
          bytes: bytes.value.subarray(8),
          contentType: "image/webp",
          expiresAt: entry.expires,
        };
      }
    }
    const running = active.get(key);
    if (running) return yield* running;
    if (active.size >= 9) return yield* new ImagePreviewError({});
    let shared = sources.get(input.identity);
    if (!shared) {
      shared = { fetch: yield* Effect.cached(input.fetch), users: 0 };
      sources.set(input.identity, shared);
    }
    shared.users++;
    const sourceEntry = shared;
    const work = yield* Effect.gen(function* () {
      const source = yield* sourceEntry.fetch;
      if (source.bytes.length > 20 * 1024 * 1024) return yield* new ImagePreviewError({});
      const data = Buffer.from(source.bytes);
      if (data.subarray(0, 3).toString() === "GIF") {
        if (input.preview.width === 64) return yield* new ImagePreviewError({});
        return { bytes: source.bytes, contentType: "image/gif", expiresAt: now + 300_000 };
      }
      const chunked =
        data.subarray(0, 4).toString() === "RIFF"
          ? "webp"
          : data.subarray(1, 4).toString() === "PNG"
            ? "png"
            : null;
      if (chunked) {
        const start = chunked === "webp" ? 12 : 8;
        for (let offset = start; offset + 8 <= data.length;) {
          const name = data
            .subarray(offset + (chunked === "png" ? 4 : 0), offset + (chunked === "png" ? 8 : 4))
            .toString();
          if (name === "ANIM" || name === "acTL") {
            if (input.preview.width === 64) return yield* new ImagePreviewError({});
            return {
              bytes: source.bytes,
              contentType: `image/${chunked}`,
              expiresAt: now + 300_000,
            };
          }
          const size =
            chunked === "webp" ? data.readUInt32LE(offset + 4) : data.readUInt32BE(offset);
          offset += chunked === "webp" ? 8 + size + (size % 2) : 12 + size;
        }
      }
      const sharp = yield* Effect.try({
        try: () => requireSharp("sharp") as typeof import("sharp").default,
        catch: () => new ImagePreviewError({}),
      });
      const image = sharp(source.bytes, { limitInputPixels: 32_000_000, animated: false });
      // Sharp cannot cancel native work: retain the permit until its promises settle.
      const bytes = yield* Effect.gen(function* () {
        const metadata = yield* Effect.tryPromise({
          try: () => image.metadata(),
          catch: () => new ImagePreviewError({}),
        });
        if ((metadata.pages ?? 1) > 1) return null;
        if (!["png", "jpeg", "webp", "avif", "heif", "tiff"].includes(metadata.format ?? "")) {
          return yield* new ImagePreviewError({});
        }
        const bytes = yield* Effect.tryPromise({
          try: () =>
            image
              .autoOrient()
              .resize({
                width: input.preview.width,
                ...(input.preview.width === 64 ? { height: 64, fit: "inside" as const } : {}),
                withoutEnlargement: true,
              })
              .webp(
                input.preview.width === 64
                  ? { quality: 35, effort: 3 }
                  : { lossless: true, effort: 4 },
              )
              .timeout({ seconds: 15 })
              .toBuffer(),
          catch: () => new ImagePreviewError({}),
        });
        return bytes;
      }).pipe(Effect.uninterruptible);
      if (bytes === null) return { ...source, expiresAt: now + 300_000 };
      if (bytes.length > 4 * 1024 * 1024) return yield* new ImagePreviewError({});
      const written = yield* Clock.currentTimeMillis;
      const header = Buffer.alloc(8);
      header.writeDoubleBE(written + 300_000);
      const stored = Buffer.concat([header, bytes]);
      const room = yield* prune(stored.length);
      if (!room) return { bytes, contentType: "image/webp", expiresAt: written + 300_000 };
      const temporary = path.join(directory, `${key}.tmp`);
      yield* fs.writeFile(temporary, stored, { flag: "wx" }).pipe(
        Effect.andThen(fs.rename(temporary, path.join(directory, key))),
        Effect.tap(() =>
          Effect.sync(() => {
            entries.set(key, { size: stored.length, expires: written + 300_000, used: written });
          }),
        ),
        Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)),
        Effect.ignore,
      );
      return { bytes, contentType: "image/webp", expiresAt: written + 300_000 };
    }).pipe(
      lock.withPermit,
      Effect.mapError(() => new ImagePreviewError({})),
      Effect.ensuring(
        Effect.sync(() => {
          active.delete(key);
          sourceEntry.users--;
          if (sourceEntry.users === 0) sources.delete(input.identity);
        }),
      ),
      Effect.forkIn(scope, { startImmediately: false }),
    );
    const joined = Fiber.join(work);
    active.set(key, joined);
    return yield* joined;
  });
  return PullRequestImagePreview.of({ read });
});

export const layer = Layer.effect(PullRequestImagePreview, make);
