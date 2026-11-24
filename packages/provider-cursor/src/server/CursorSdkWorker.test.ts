// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { CursorAgentSdkRunnerError, cursorSdkFailureMessage } from "./CursorAgentSdk.ts";
import { makeCursorSdkWorkerApi } from "./CursorSdkWorker.ts";

it("preserves SDK failure reasons and diagnostics across the worker boundary", async () => {
  const scratchDir = NodePath.resolve(import.meta.dirname, "../../../../.scratch");
  NodeFS.mkdirSync(scratchDir, { recursive: true });
  const directory = NodeFS.mkdtempSync(NodePath.join(scratchDir, "cursor-worker-errors-"));
  const modulePath = NodePath.join(directory, "synthetic-sdk.cjs");
  NodeFS.writeFileSync(
    modulePath,
    `
    class SdkError extends Error {
      constructor() {
        super('Too many requests');
        this.name='SdkError';this.code='resource_exhausted';this.status=429;
        this.nonserializable=()=>{};
      }
    }
    exports.Agent={create:async()=>({agentId:'synthetic',close(){},async summarize(){
      return {id:'summary',agentId:'synthetic',wait:async()=>({summary:true}),cancel:async()=>({cancelled:true})};
    },async send(){
      return {id:'run',agentId:'synthetic',wait:async()=>{throw new SdkError();}};
    }})};
    `,
  );
  try {
    const api = makeCursorSdkWorkerApi(modulePath, process.env);
    const session = await api.create({});
    try {
      const summary = await session.summarize();
      assert.deepEqual((await summary.wait()) as unknown, { summary: true });
      assert.deepEqual((await summary.cancel()) as unknown, { cancelled: true });
      const run = await session.send("synthetic");
      const cause = await run.wait().then(
        () => assert.fail("Expected SDK failure"),
        (error: unknown) => error,
      );
      assert.instanceOf(cause, Error);
      assert.equal((cause as Error).name, "SdkError");
      assert.equal(
        cursorSdkFailureMessage(new CursorAgentSdkRunnerError({ method: "run.wait", cause })),
        "Cursor Agent SDK run.wait failed: Too many requests (resource_exhausted, HTTP 429)",
      );
    } finally {
      await session.close();
    }
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it("isolates concurrent provider environments in actual shell children and preserves SDK operations", async () => {
  const scratchDir = NodePath.resolve(import.meta.dirname, "../../../../.scratch");
  NodeFS.mkdirSync(scratchDir, { recursive: true });
  const directory = NodeFS.mkdtempSync(NodePath.join(scratchDir, "upstream-v2-cursor-worker-"));
  const modulePath = NodePath.join(directory, "synthetic-sdk.cjs");
  NodeFS.writeFileSync(
    modulePath,
    `
    const {spawnSync}=require('node:child_process');
    let cancelled=false;
    let useHttp1ForAgent;
    exports.Cursor={configure:({local})=>{useHttp1ForAgent=local.useHttp1ForAgent;}};
    const shell=()=>JSON.parse(spawnSync(process.execPath,['-e','process.stdout.write(JSON.stringify({port:process.env.PORT,device:process.env.STYAL_DEVICE,profile:process.env.CURSOR_PROFILE}))'],{encoding:'utf8'}).stdout);
    const agent=(id)=>({agentId:id,close(){},async send(message,options){
      await options.onDelta({update:{type:'synthetic',environment:shell()}});
      globalThis[Symbol.for('@cursor/sdk.shellStreamOutput')]?.({conversationId:id,toolCallId:'shell-1',event:{case:'stdout',value:{data:'building'}}});
      return {id:'run',agentId:id,wait:async()=>message==='hang'?new Promise(()=>{}):({environment:shell(),cancelled,useHttp1ForAgent}),steer:async()=> 'complete_delivered',cancel:async()=>{cancelled=true;}};
    }});
    exports.Agent={create:async()=>agent('created'),resume:async(id)=>agent(id),listRuns:async()=>({items:[]}),cancelRun:async()=>{cancelled=true;},messages:{list:async()=>[{environment:shell()}]}};
  `,
  );
  const originalPort = process.env.PORT;
  const first = makeCursorSdkWorkerApi(
    modulePath,
    {
      ...process.env,
      PORT: "41001",
      STYAL_DEVICE: "synthetic-ios",
      CURSOR_PROFILE: "one",
    },
    undefined,
    true,
  );
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
      {
        environment: { port: "41001", device: "synthetic-ios", profile: "one" },
        cancelled: true,
        useHttp1ForAgent: true,
      },
      {
        environment: { port: "41002", device: "synthetic-android", profile: "two" },
        cancelled: false,
        useHttp1ForAgent: undefined,
      },
    ]);
    assert.equal(deltas.length, 4);
    assert.deepEqual(
      deltas.filter((delta) => (delta as { type: string }).type === "shell-output-delta"),
      [
        {
          type: "shell-output-delta",
          event: { case: "stdout", value: { data: "building" }, toolCallId: "shell-1" },
        },
        {
          type: "shell-output-delta",
          event: { case: "stdout", value: { data: "building" }, toolCallId: "shell-1" },
        },
      ],
    );
    assert.equal(await runs[1]!.steer!("finish the build"), "complete_delivered");
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

it("resumes a moved session and recovers runs and messages from its original store", async () => {
  const scratchDir = NodePath.resolve(import.meta.dirname, "../../../../.scratch");
  NodeFS.mkdirSync(scratchDir, { recursive: true });
  const directory = NodeFS.mkdtempSync(NodePath.join(scratchDir, "cursor-moved-store-"));
  const modulePath = NodePath.join(directory, "synthetic-sdk.cjs");
  NodeFS.writeFileSync(
    modulePath,
    `
    exports.Agent={resume:async()=>{throw new Error('wrong store');}};
    exports.createAgentPlatform=async({workspaceRef,localStore})=>({
      resumeAgent:async(id,options)=>({agentId:id,close(){},async send(){return {id:'run',agentId:id,wait:async()=>({cwd:options.local.cwd,workspaceRef,localStore}),cancel:async()=>{}};}}),
      listRuns:async(id,options)=>({items:[],nextCursor:options.cursor,workspaceRef}),
      cancelRun:async(id)=>({id,workspaceRef}),
      getAgentMessages:async(id)=>[{id,workspaceRef}]
    });
  `,
  );
  const api = makeCursorSdkWorkerApi(modulePath, process.env, "/original/workspace");
  try {
    const session = await api.resume("moved", { local: { cwd: "/new/workspace" } });
    try {
      const run = await session.send("continue");
      assert.deepEqual<unknown>(await run.wait(), {
        cwd: "/new/workspace",
        localStore: undefined,
        workspaceRef: "/original/workspace",
      });
      assert.deepEqual<unknown>(
        await api.listRuns("moved", { runtime: "local", cursor: "page-two" }),
        { items: [], nextCursor: "page-two", workspaceRef: "/original/workspace" },
      );
      assert.deepEqual<unknown>(await api.cancelRun("orphan", { runtime: "local" }), {
        id: "orphan",
        workspaceRef: "/original/workspace",
      });
      assert.deepEqual<unknown>(await api.messages.list("moved", { runtime: "local" }), [
        { id: "moved", workspaceRef: "/original/workspace" },
      ]);
    } finally {
      await session.close();
    }
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
