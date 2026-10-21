// @effect-diagnostics nodeBuiltinImport:off -- The check runs in a plain Node child so its module cache starts empty.
import * as NodeChildProcess from "node:child_process";
import { expect, vi } from "vite-plus/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CursorSdk from "./CursorSdk.ts";

const cursorSdkUrl = new URL("./CursorSdk.ts", import.meta.url).href;

it("constructs the Cursor runtime without loading either SDK until used", () => {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
const require = createRequire(${JSON.stringify(import.meta.url)});
const sdkPath = require.resolve("@cursor/sdk");
const sqlitePath = require.resolve("@cursor/sdk/sqlite");
const { CursorSdk, layer } = await import(${JSON.stringify(cursorSdkUrl)});
const { makeCursorAgentSdkRunner } = await import(${JSON.stringify(new URL("./CursorAgentSdk.ts", import.meta.url).href)});
const { makeCursorTextGeneration } = await import(${JSON.stringify(new URL("./textGeneration.ts", import.meta.url).href)});
await import(${JSON.stringify(new URL("./auth.ts", import.meta.url).href)});
await import(${JSON.stringify(new URL("./CursorSdkCatalog.ts", import.meta.url).href)});
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const context = yield* Layer.build(layer);
  yield* Effect.gen(function* () {
    yield* makeCursorAgentSdkRunner(() => undefined);
    yield* makeCursorTextGeneration({ enabled: false });
    const sdk = yield* CursorSdk;
    assert.equal(require.cache[sdkPath], undefined);
    assert.equal(require.cache[sqlitePath], undefined);
    assert.equal(typeof sdk.Agent.create, "function");
    assert.ok(require.cache[sdkPath]);
    assert.equal(require.cache[sqlitePath], undefined);
    assert.equal(typeof sdk.SqliteLocalAgentStore, "function");
    assert.ok(require.cache[sqlitePath]);
  }).pipe(Effect.provideContext(context), Effect.provide(NodeServices.layer));
})));
`,
    ],
    { encoding: "utf8", cwd: new URL("../../", import.meta.url) },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
vi.mock("./sdk.ts", () => ({
  loadCursorSdk: () => ({ Agent: {}, createAgentPlatform: {} }),
  loadCursorSqliteSdk: () => ({ SqliteLocalAgentStore: {} }),
}));

// Shaped like the SDK's minified class: the constructor is not named after the error.
class o extends Error {
  override name = "WriteIterableClosedError";
}

// Calls the guard directly, with Vitest's own listener detached so the guard does not defer to it.
const rejectThroughGuard = (reason: unknown) =>
  Effect.gen(function* () {
    const others = process.listeners("unhandledRejection");
    yield* Layer.build(CursorSdk.layer);
    const guard = process.listeners("unhandledRejection").find((l) => !others.includes(l));
    assert.isDefined(guard);
    using exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    using _log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const listener of others) process.off("unhandledRejection", listener);
    try {
      guard(reason, Promise.resolve());
    } finally {
      for (const listener of others) process.on("unhandledRejection", listener);
    }
    return exit.mock.calls;
  }).pipe(Effect.scoped);

describe("CursorSdk unhandled rejection guard", () => {
  it.effect("keeps the server running when the SDK writes to a closed stream", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* rejectThroughGuard(new o("WritableIterable is closed")), []);
    }),
  );

  it.effect("still exits on other rejections", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* rejectThroughGuard(new Error("WritableIterable is closed")), [
        [1],
      ]);
    }),
  );
});
