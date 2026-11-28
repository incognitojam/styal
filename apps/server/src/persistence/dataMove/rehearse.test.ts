// @effect-diagnostics globalFetch:off -- Exercise the host viewer with the same fetch API as its browser controls.
// @effect-diagnostics nodeBuiltinImport:off -- Synthetic offline launcher refusals.
import * as NodeFS from "node:fs";
import { createRehearsalViewer } from "./rehearseViewer.ts";
import { rehearsalNetworkFilter } from "./rehearseNetwork.ts";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { archive } from "./archive.ts";
import { neutralise } from "./neutralise.ts";
import { migrate } from "./migrate.ts";
import { rehearse } from "./rehearse.ts";

it.effect(
  "refuses live paths, unmoved sources, absent/damaged markers and cutover copies before launching",
  () =>
    Effect.gen(function* () {
      const runtime = { platform: "linux" as const, architecture: "x64" };
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rehearsal-refusals-"));
      const file = NodePath.join(root, "source.sqlite");
      try {
        NodeFS.writeFileSync(
          file,
          NodeZlib.gunzipSync(
            NodeFS.readFileSync(new URL("./fixtures/preflight.sqlite.gz", import.meta.url)),
          ),
        );
        yield* Effect.promise(() =>
          expect(
            rehearse(
              NodePath.join(NodeOS.userInfo().homedir, ".styal/rehearsal-refused.sqlite"),
              runtime,
            ),
          ).rejects.toMatchObject({ category: "live-styal-home-refused" }),
        );
        yield* Effect.promise(() =>
          expect(rehearse(file, runtime)).rejects.toMatchObject({
            category: "completion-marker-required",
          }),
        );
        yield* archive(file);
        yield* neutralise(file, "cutover");
        yield* migrate(file);
        yield* Effect.promise(() =>
          expect(rehearse(file, runtime)).rejects.toMatchObject({
            category: "rehearsal-mode-required",
          }),
        );
        const db = new NodeSqlite.DatabaseSync(file);
        db.exec("UPDATE styal_data_move SET neutralisation_sha256 = 'invalid'");
        db.close();
        yield* Effect.promise(() => expect(rehearse(file, runtime)).rejects.toBeDefined());
        const unmarked = new NodeSqlite.DatabaseSync(file);
        unmarked.exec("DROP TABLE styal_data_move");
        unmarked.close();
        yield* Effect.promise(() =>
          expect(rehearse(file, runtime)).rejects.toMatchObject({
            category: "completion-marker-required",
          }),
        );
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
);

it("keeps sandbox HTML, redirects and input responses out of the host browser", async () => {
  let status = 302;
  let bytes = Buffer.from('<script>location="https://example.invalid"</script>');
  const viewer = createRehearsalViewer(async () => ({ status, bytes }));
  await new Promise<void>((resolve, reject) => {
    viewer.once("error", reject);
    viewer.listen(0, "127.0.0.1", () => {
      viewer.off("error", reject);
      resolve();
    });
  });
  const address = viewer.address();
  if (address === null || typeof address === "string") throw new Error("listener-required");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const root = await fetch(url);
    expect(await root.text()).toContain("Refresh view");
    expect(root.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect((await fetch(url + "/frame")).status).toBe(503);
    status = 200;
    expect((await fetch(url + "/frame")).status).toBe(503);
    const input = await fetch(url + "/input", { method: "POST", body: "{}" });
    expect(await input.text()).toBe("");
    expect(input.headers.get("location")).toBeNull();
    bytes = Buffer.from("89504e470d0a1a0a", "hex");
    const image = await fetch(url + "/frame");
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes);
    expect((await fetch(url + "/untrusted")).status).toBe(404);
  } finally {
    const closed = new Promise<void>((resolve, reject) =>
      viewer.close((error) => (error ? reject(error) : resolve())),
    );
    viewer.closeAllConnections();
    await closed;
  }
});

it.each(["x64", "arm64"])(
  "restricts the %s socket ABI and prevents io_uring socket creation",
  (architecture) => {
    const filter = rehearsalNetworkFilter(architecture);
    const abi = architecture === "x64" ? [0xc000003e, 41, 53] : [0xc00000b7, 198, 199];
    const evaluate = (arch: number, syscall: number, family: number, protocol = 0) => {
      const data = Buffer.alloc(64);
      data.writeUInt32LE(syscall >>> 0, 0);
      data.writeUInt32LE(arch >>> 0, 4);
      data.writeUInt32LE(family >>> 0, 16);
      data.writeUInt32LE(protocol >>> 0, 32);
      let value = 0;
      for (let pc = 0; pc < filter.length / 8; pc++) {
        const code = filter.readUInt16LE(pc * 8);
        const yes = filter[pc * 8 + 2]!;
        const no = filter[pc * 8 + 3]!;
        const k = filter.readUInt32LE(pc * 8 + 4);
        if (code === 0x20) value = data.readUInt32LE(k);
        else if (code === 0x15) pc += value === k ? yes : no;
        else if (code === 0x35) pc += value >= k ? yes : no;
        else if (code === 0x06) return k;
        else throw new Error("unsupported-filter-instruction");
      }
      throw new Error("unterminated-filter");
    };
    const [arch, socket, pair] = abi;
    for (const syscall of [socket!, pair!]) {
      for (const family of [1, 2, 10, 16])
        expect(evaluate(arch!, syscall, family)).toBe(0x7fff0000);
      for (const family of [0, 17, 40]) expect(evaluate(arch!, syscall, family)).toBe(0x00050001);
      expect(evaluate(arch!, syscall, 16, 9)).toBe(0x00050001);
      expect(evaluate(arch! ^ 1, syscall, 1)).toBe(0x00050001);
      expect(evaluate(arch!, syscall + 0x40000000, 1)).toBe(0x00050001);
    }
    expect(evaluate(arch!, 425, 0)).toBe(0x00050001);
    expect(evaluate(arch!, 0, 0)).toBe(0x7fff0000);
  },
);
