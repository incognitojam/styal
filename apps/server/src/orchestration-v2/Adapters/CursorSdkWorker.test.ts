// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { makeCursorSdkWorkerApi } from "./CursorSdkWorker.ts";

it("isolates concurrent provider environments in actual shell children and preserves SDK operations", async () => {
  const scratchDir = NodePath.resolve(import.meta.dirname, "../../../../../.scratch");
  NodeFS.mkdirSync(scratchDir, { recursive: true });
  const directory = NodeFS.mkdtempSync(NodePath.join(scratchDir, "upstream-v2-cursor-worker-"));
  const modulePath = NodePath.join(directory, "synthetic-sdk.cjs");
  NodeFS.writeFileSync(
    modulePath,
    `
    const {spawnSync}=require('node:child_process');
    let cancelled=false;
    const shell=()=>JSON.parse(spawnSync(process.execPath,['-e','process.stdout.write(JSON.stringify({port:process.env.PORT,device:process.env.STYAL_DEVICE,profile:process.env.CURSOR_PROFILE}))'],{encoding:'utf8'}).stdout);
    const agent=(id)=>({agentId:id,close(){},async send(message,options){
      await options.onDelta({update:{type:'synthetic',environment:shell()}});
      return {id:'run',agentId:id,wait:async()=>message==='hang'?new Promise(()=>{}):({environment:shell(),cancelled}),cancel:async()=>{cancelled=true;}};
    }});
    exports.Agent={create:async()=>agent('created'),resume:async(id)=>agent(id),listRuns:async()=>({items:[]}),cancelRun:async()=>{cancelled=true;},messages:{list:async()=>[{environment:shell()}]}};
  `,
  );
  const originalPort = process.env.PORT;
  const first = makeCursorSdkWorkerApi(modulePath, {
    ...process.env,
    PORT: "41001",
    STYAL_DEVICE: "synthetic-ios",
    CURSOR_PROFILE: "one",
  });
  const second = makeCursorSdkWorkerApi(modulePath, {
    ...process.env,
    PORT: "41002",
    STYAL_DEVICE: "synthetic-android",
    CURSOR_PROFILE: "two",
  });
  const sessions = await Promise.all([first.create({}), second.resume("resumed", {})]);
  let firstClosed = false;
  try {
    const deltas: unknown[] = [];
    const runs = await Promise.all(
      sessions.map((session) =>
        session.send("synthetic", {
          onDelta: async ({ update }) => {
            deltas.push(update);
          },
        }),
      ),
    );
    await runs[0]!.cancel();
    const results = await Promise.all(runs.map((run) => run.wait()));
    assert.deepEqual<unknown>(results, [
      { environment: { port: "41001", device: "synthetic-ios", profile: "one" }, cancelled: true },
      {
        environment: { port: "41002", device: "synthetic-android", profile: "two" },
        cancelled: false,
      },
    ]);
    assert.equal(deltas.length, 2);
    assert.equal(sessions[1]!.agentId, "resumed");
    assert.deepEqual<unknown>(await first.messages.list("created", { runtime: "local" }), [
      { environment: { port: "41001", device: "synthetic-ios", profile: "one" } },
    ]);
    assert.deepEqual(await second.listRuns("resumed", { runtime: "local" }), { items: [] });
    await second.cancelRun("run", { runtime: "local" });
    assert.equal(process.env.PORT, originalPort);
    const hanging = await sessions[0]!.send("hang", { onDelta: async () => {} });
    const waiting = hanging.wait().then(
      () => "unexpected completion",
      (error: unknown) => error,
    );
    await sessions[0]!.close();
    firstClosed = true;
    const failure = await waiting;
    assert.isTrue(failure instanceof Error && /session closed/.test(failure.message));
  } finally {
    await Promise.all(
      sessions.filter((_, index) => index !== 0 || !firstClosed).map((session) => session.close()),
    );
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
