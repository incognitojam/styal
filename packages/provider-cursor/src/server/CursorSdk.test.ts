// @effect-diagnostics nodeBuiltinImport:off -- The check runs in a plain Node child so its module cache starts empty.
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "vite-plus/test";

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
