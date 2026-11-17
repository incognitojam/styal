import * as NodeModule from "node:module";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import sharp, { type Metadata, type Sharp } from "sharp";
import * as Preview from "./PullRequestImagePreview.ts";
import * as ServerConfig from "../config.ts";

it.effect(
  "resizes real raster bytes, reuses the disk derivative, and keeps originals separate",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "pr-images-test-",
      });
      let fetches = 0;
      const bytes = yield* Effect.promise(() =>
        sharp({ create: { width: 800, height: 400, channels: 4, background: "#34567880" } })
          .png()
          .toBuffer(),
      );
      const pixels = Buffer.alloc(400 * 320 * 3);
      let seed = 7;
      for (let index = 0; index < pixels.length; index += 3) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const noise = (seed >>> 24) % 100 < 1 ? (seed >>> 16) & 3 : 0;
        pixels[index] = 244 - noise;
        pixels[index + 1] = 246 - noise;
        pixels[index + 2] = 250 - noise;
      }
      const bars = Array.from(
        { length: 20 },
        (_, index) =>
          `<rect x="16" y="${12 + index * 15}" width="${368 - index * 3}" height="5" fill="${index % 3 ? "#283247" : "#0865cf"}"/>`,
      ).join("");
      const noisyBytes = yield* Effect.promise(() =>
        sharp(pixels, { raw: { width: 400, height: 320, channels: 3 } })
          .composite([{ input: Buffer.from(`<svg width="400" height="320">${bars}</svg>`) }])
          .png({ compressionLevel: 9 })
          .toBuffer(),
      );
      let noisyFetches = 0;
      const noisy = {
        identity: "synthetic-noisy-screenshot",
        preview: { width: 320 as const },
        fetch: Effect.sync(() => {
          noisyFetches++;
          return { bytes: noisyBytes, contentType: "image/png" };
        }),
      };
      const input = {
        identity: "synthetic-account/repository/revision",
        preview: { width: 320 as const },
        fetch: Effect.sync(() => {
          fetches++;
          return { bytes, contentType: "image/png" };
        }),
      };
      const layer = Preview.layer.pipe(
        Layer.provide(
          Layer.succeed(ServerConfig.ServerConfig, {
            stateDir: directory,
          } as ServerConfig.ServerConfig["Service"]),
        ),
      );
      const run = Effect.gen(function* () {
        const previews = yield* Preview.PullRequestImagePreview;
        const original = yield* previews.read(noisy);
        expect(original.bytes).toEqual(noisyBytes);
        expect(original.contentType).toBe("image/png");
        expect(yield* previews.read(noisy)).toEqual(original);
        expect(noisyFetches).toBe(1);
        const result = yield* previews.read(input);
        const metadata = yield* Effect.promise(() => sharp(result.bytes).metadata());
        expect(result.contentType).toBe("image/webp");
        expect(
          yield* Effect.promise(() => sharp(result.bytes).ensureAlpha().raw().toBuffer()),
        ).toEqual(
          yield* Effect.promise(() =>
            sharp(bytes).resize({ width: 320 }).ensureAlpha().raw().toBuffer(),
          ),
        );
        expect(metadata).toMatchObject({ width: 320, height: 160, hasAlpha: true });
        expect((yield* previews.read(input)).bytes).toEqual(result.bytes);
        expect(fetches).toBe(1);
        const larger = yield* previews.read({ ...input, preview: { width: 960 } });
        expect(yield* Effect.promise(() => sharp(larger.bytes).metadata())).toMatchObject({
          width: 800,
          height: 400,
        });
        const animation = Buffer.from(
          "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
          "base64",
        );
        expect(
          (yield* previews.read({
            ...input,
            identity: "gif",
            fetch: Effect.succeed({ bytes: animation, contentType: "image/gif" }),
          })).bytes,
        ).toEqual(animation);
        expect(fetches).toBe(2);
        const tiny = yield* previews.read({ ...input, preview: { width: 64 } });
        expect(tiny.sourceDimensions).toEqual({ width: 800, height: 400 });
        expect(tiny.bytes.length).toBeLessThan(1024);
        expect(yield* Effect.promise(() => sharp(tiny.bytes).metadata())).toMatchObject({
          width: 64,
          height: 32,
        });
        const svg = Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="blue"/></svg>',
        );
        const vector = {
          ...input,
          identity: "extensionless-svg",
          fetch: Effect.succeed({ bytes: svg, contentType: "image/svg+xml" }),
        };
        expect((yield* previews.read(vector)).bytes).toEqual(svg);
        expect((yield* previews.read(vector)).contentType).toBe("image/svg+xml");
        expect(
          (yield* previews.read({ ...vector, preview: { width: 64 } }).pipe(Effect.exit))._tag,
        ).toBe("Failure");
        yield* Effect.all(
          [
            previews.read({ ...input, identity: "parallel", preview: { width: 64 } }),
            previews.read({ ...input, identity: "parallel", preview: { width: 640 } }),
          ],
          { concurrency: "unbounded" },
        );
        expect(fetches).toBe(4);
        const firstFetch = yield* Deferred.make<void>();
        const secondFetch = yield* Deferred.make<void>();
        const first = yield* previews
          .read({
            ...input,
            identity: "independent-first",
            fetch: Deferred.succeed(firstFetch, undefined).pipe(
              Effect.andThen(Deferred.await(secondFetch)),
              Effect.as({ bytes, contentType: "image/png" }),
            ),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstFetch);
        yield* previews.read({
          ...input,
          identity: "independent-second",
          fetch: Deferred.succeed(secondFetch, undefined).pipe(
            Effect.as({ bytes, contentType: "image/png" }),
          ),
        });
        yield* Fiber.join(first);
        const oversized = yield* previews
          .read({
            ...input,
            identity: "oversized",
            fetch: Effect.succeed({
              bytes: new Uint8Array(21 * 1024 * 1024),
              contentType: "image/png",
            }),
          })
          .pipe(Effect.result);
        expect(oversized._tag).toBe("Failure");
        const failed = yield* previews
          .read({
            ...input,
            identity: "corrupt",
            fetch: Effect.succeed({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" }),
          })
          .pipe(Effect.result);
        expect(failed._tag).toBe("Failure");
      });
      yield* run.pipe(Effect.provide(layer));
      yield* Effect.gen(function* () {
        const previews = yield* Preview.PullRequestImagePreview;
        const persisted = yield* previews.read(noisy);
        expect(persisted.bytes).toEqual(noisyBytes);
        expect(persisted.contentType).toBe("image/png");
        expect(noisyFetches).toBe(1);
        const cached = yield* previews.read(input);
        expect(fetches).toBe(4);
        yield* TestClock.adjust("4 minutes");
        expect((yield* previews.read(input)).expiresAt).toBe(cached.expiresAt);
        yield* TestClock.adjust("2 minutes");
        yield* previews.read(input);
        expect(fetches).toBe(5);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.effect("aborts the source fetch only when its last shared preview waiter leaves", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pr-images-abort-" });
    const started = yield* Deferred.make<void>();
    const aborted = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const previews = yield* Preview.PullRequestImagePreview;
      const read = previews.read({
        identity: "cancelled-source",
        preview: { width: 320 },
        fetch: Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(
          Effect.onInterrupt(() => Deferred.succeed(aborted, undefined)),
        ),
      });
      const request = yield* Effect.forkChild(read, { startImmediately: true });
      yield* Deferred.await(started);
      const shared = yield* Effect.forkChild(read, { startImmediately: true });
      yield* Fiber.interrupt(request);
      expect(yield* Deferred.isDone(aborted)).toBe(false);
      yield* Fiber.interrupt(shared);
      expect(yield* Deferred.isDone(aborted)).toBe(true);
    }).pipe(
      Effect.provide(
        Preview.layer.pipe(
          Layer.provide(
            Layer.succeed(ServerConfig.ServerConfig, {
              stateDir: directory,
            } as ServerConfig.ServerConfig["Service"]),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.effect("holds native work and its permit until settlement after cancellation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({
      prefix: "pr-images-cancel-",
    });
    const bytes = yield* Effect.promise(() =>
      sharp({ create: { width: 10, height: 10, channels: 3, background: "#123456" } })
        .png()
        .toBuffer(),
    );
    const started = yield* Deferred.make<void>();
    const pending = Promise.withResolvers<Metadata>();
    const nativeSharp = NodeModule.createRequire(import.meta.url)("sharp") as typeof sharp;
    const fixtureMetadata = yield* Effect.promise(() => nativeSharp(bytes).metadata());
    const metadata = nativeSharp.prototype.metadata;
    let calls = 0;
    using _metadata = vi.spyOn(nativeSharp.prototype, "metadata").mockImplementation(function (
      this: Sharp,
    ) {
      calls++;
      if (calls === 1) {
        Deferred.doneUnsafe(started, Effect.void);
        return pending.promise;
      }
      return metadata.call(this);
    });
    yield* Effect.gen(function* () {
      const previews = yield* Preview.PullRequestImagePreview;
      const read = (identity: string) =>
        previews.read({
          identity,
          preview: { width: 320 },
          fetch: Effect.succeed({ bytes, contentType: "image/png" }),
        });
      const first = yield* Effect.forkChild(read("first"), { startImmediately: true });
      yield* Deferred.await(started);
      const cancelling = yield* Effect.forkChild(Fiber.interrupt(first), {
        startImmediately: true,
      });
      const second = yield* Effect.forkChild(read("second"), { startImmediately: true });
      expect(calls).toBe(1);
      pending.resolve(fixtureMetadata);
      yield* Fiber.join(cancelling);
      yield* Fiber.join(second);
      expect(calls).toBe(2);
    }).pipe(
      Effect.provide(
        Preview.layer.pipe(
          Layer.provide(
            Layer.succeed(ServerConfig.ServerConfig, {
              stateDir: directory,
            } as ServerConfig.ServerConfig["Service"]),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.effect("retains failed evictions and retries before admitting another cache entry", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({
      prefix: "pr-images-evict-",
    });
    const cache = `${directory}/cache/pr-image-previews/v1`;
    yield* fs.makeDirectory(cache, { recursive: true });
    const expired = Buffer.alloc(9);
    yield* Effect.all(
      Array.from({ length: 2000 }, (_, index) =>
        fs.writeFile(`${cache}/${index.toString(16).padStart(64, "0")}`, expired),
      ),
      { concurrency: 20 },
    );
    let blocked = true;
    const faulty = {
      ...fs,
      remove: (path: string, options?: Parameters<typeof fs.remove>[1]) =>
        blocked && /\/[a-f0-9]{64}$/.test(path)
          ? fs.remove(`${cache}/synthetic-missing`, { recursive: false })
          : fs.remove(path, options),
    };
    const bytes = yield* Effect.promise(() =>
      sharp({ create: { width: 10, height: 10, channels: 3, background: "#123456" } })
        .png()
        .toBuffer(),
    );
    yield* Effect.gen(function* () {
      const previews = yield* Preview.PullRequestImagePreview;
      const read = (identity: string) =>
        previews.read({
          identity,
          preview: { width: 320 },
          fetch: Effect.succeed({ bytes, contentType: "image/png" }),
        });
      expect((yield* read("blocked")).contentType).toBe("image/webp");
      expect((yield* fs.readDirectory(cache)).length).toBe(2000);
      blocked = false;
      yield* read("recovered");
      expect((yield* fs.readDirectory(cache)).length).toBe(1);
    }).pipe(
      Effect.provide(
        Preview.layer.pipe(
          Layer.provide(
            Layer.succeed(ServerConfig.ServerConfig, {
              stateDir: directory,
            } as ServerConfig.ServerConfig["Service"]),
          ),
          Layer.provide(Layer.succeed(FileSystem.FileSystem, faulty)),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);
