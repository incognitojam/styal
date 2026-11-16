import * as TestClock from "effect/testing/TestClock";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import sharp from "sharp";
import * as Preview from "./PullRequestImagePreview.ts";
import * as ServerConfig from "../config.ts";

it.effect(
  "resizes real raster bytes, reuses the disk derivative, and keeps originals separate",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: ".scratch",
        prefix: "pr-images-test-",
      });
      let fetches = 0;
      const bytes = yield* Effect.tryPromise(() =>
        sharp({ create: { width: 800, height: 400, channels: 4, background: "#34567880" } })
          .png()
          .toBuffer(),
      );
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
        const result = yield* previews.read(input);
        const metadata = yield* Effect.tryPromise(() => sharp(result.bytes).metadata());
        expect(result.contentType).toBe("image/webp");
        expect(metadata).toMatchObject({ width: 320, height: 160, hasAlpha: true });
        expect((yield* previews.read(input)).bytes).toEqual(result.bytes);
        expect(fetches).toBe(1);
        const larger = yield* previews.read({ ...input, preview: { width: 960 } });
        expect(yield* Effect.tryPromise(() => sharp(larger.bytes).metadata())).toMatchObject({
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
        expect(tiny.bytes.length).toBeLessThan(1024);
        expect(yield* Effect.tryPromise(() => sharp(tiny.bytes).metadata())).toMatchObject({
          width: 64,
          height: 32,
        });
        yield* Effect.all(
          [
            previews.read({ ...input, identity: "parallel", preview: { width: 320 } }),
            previews.read({ ...input, identity: "parallel", preview: { width: 640 } }),
          ],
          { concurrency: "unbounded" },
        );
        expect(fetches).toBe(4);
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
        yield* previews.read(input);
        expect(fetches).toBe(4);
        yield* TestClock.adjust("6 minutes");
        yield* previews.read(input);
        expect(fetches).toBe(5);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);
