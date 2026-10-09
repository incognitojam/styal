// @effect-diagnostics nodeBuiltinImport:off
import * as NodeWorkerThreads from "node:worker_threads";
import type { Agent } from "@cursor/sdk";

export type CursorSdkAgent = Pick<Awaited<ReturnType<typeof Agent.create>>, "agentId" | "send"> & {
  readonly close: () => void | Promise<void>;
};
export interface CursorSdkApi {
  readonly create: (options: Parameters<typeof Agent.create>[0]) => Promise<CursorSdkAgent>;
  readonly resume: (
    id: string,
    options: Parameters<typeof Agent.resume>[1],
  ) => Promise<CursorSdkAgent>;
  readonly listRuns: typeof Agent.listRuns;
  readonly cancelRun: typeof Agent.cancelRun;
  readonly messages: Pick<typeof Agent.messages, "list">;
}

// The SDK has no per-agent environment option. A worker owns its process.env;
// its shell children inherit that environment, without changing another session.
const workerSource = String.raw`
const {parentPort,workerData}=require('node:worker_threads');
const {Agent,createAgentPlatform}=require(workerData.modulePath);
let agent;
const runs=new Map();
parentPort.on('message',async ({id,method,args})=>{
  try {
    let result;
    switch(method){
      case 'open': {
        const [operation,agentId,rawOptions]=args; const options=rawOptions??{};
        if(options.local?.sandboxOptions?.enabled===false){
          try {
            const cwd=typeof options.local.cwd==='string'?options.local.cwd:undefined;
            const platform=await createAgentPlatform(cwd===undefined?{}:{workspaceRef:cwd});
            const release=await platform.prewarmLocalWorkspace({apiKey:options.apiKey,local:{cwd,settingSources:[],sandboxOptions:{enabled:true}}});
            await release();
          } catch {}
        }
        agent=operation==='create'?await Agent.create(options):await Agent.resume(agentId,options);
        result={agentId:agent.agentId}; break;
      }
      case 'send': {
        const run=await agent.send(args[0],{...args[1],onDelta:async ({update})=>{parentPort.postMessage({update});}});
        runs.set(run.id,run);result={id:run.id,agentId:run.agentId};break;
      }
      case 'wait': result=await runs.get(args[0]).wait();break;
      case 'cancel': result=await runs.get(args[0]).cancel();break;
      case 'listRuns': result=await Agent.listRuns(...args);break;
      case 'cancelRun': result=await Agent.cancelRun(...args);break;
      case 'messages': result=await Agent.messages.list(...args);break;
      case 'close': result=await agent.close();break;
      default: throw new Error('Unknown Cursor worker operation.');
    }
    parentPort.postMessage({id,result});
  } catch(error) {parentPort.postMessage({id,error:{name:error?.name,message:error?.message??String(error),stack:error?.stack}});}
});
`;

export function makeCursorSdkWorkerApi(
  modulePath: string,
  environment: NodeJS.ProcessEnv,
): CursorSdkApi {
  const worker = new NodeWorkerThreads.Worker(workerSource, {
    eval: true,
    env: environment,
    workerData: { modulePath },
  });
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let closed = false;
  let failed: Error | undefined;
  let onDelta: NonNullable<Parameters<CursorSdkAgent["send"]>[1]>["onDelta"];
  const fail = (error: Error) => {
    failed = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  worker.on("error", fail);
  worker.on("exit", (code) => {
    if (!closed) fail(new Error(`Cursor SDK worker exited (${code}).`));
  });
  worker.on(
    "message",
    (frame: {
      id?: number;
      result?: unknown;
      update?: Parameters<NonNullable<typeof onDelta>>[0]["update"];
      error?: { name: string; message: string; stack?: string };
    }) => {
      if (frame.update !== undefined) {
        Promise.resolve()
          .then(() => onDelta?.({ update: frame.update! }))
          .catch(fail);
        return;
      }
      const request = frame.id === undefined ? undefined : pending.get(frame.id);
      if (request === undefined) return;
      pending.delete(frame.id!);
      if (frame.error !== undefined) {
        const error = new Error(frame.error.message);
        error.name = frame.error.name;
        if (frame.error.stack !== undefined) error.stack = frame.error.stack;
        request.reject(error);
      } else request.resolve(frame.result);
    },
  );
  const call = <Result>(method: string, args: readonly unknown[]): Promise<Result> => {
    if (failed !== undefined || closed)
      return Promise.reject(failed ?? new Error("Cursor SDK worker is closed."));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: (value) => resolve(value as Result), reject });
      try {
        worker.postMessage({ id, method, args });
      } catch (cause) {
        pending.delete(id);
        reject(cause);
      }
    });
  };
  const open = async (
    operation: "create" | "resume",
    agentId: string | undefined,
    options: Parameters<typeof Agent.resume>[1],
  ): Promise<CursorSdkAgent> => {
    try {
      const opened = await call<{ agentId: string }>("open", [operation, agentId, options]);
      return {
        agentId: opened.agentId,
        send: async (message, options) => {
          onDelta = options?.onDelta;
          const { onDelta: _onDelta, ...serializableOptions } = options ?? {};
          const run = await call<{ id: string; agentId: string }>("send", [
            message,
            serializableOptions,
          ]);
          return {
            ...run,
            wait: () => call("wait", [run.id]),
            cancel: () => call("cancel", [run.id]),
          } as Awaited<ReturnType<CursorSdkAgent["send"]>>;
        },
        close: async () => {
          try {
            await call("close", []);
          } finally {
            closed = true;
            fail(new Error("Cursor SDK session closed."));
            await worker.terminate();
          }
        },
      };
    } catch (cause) {
      closed = true;
      await worker.terminate();
      throw cause;
    }
  };
  return {
    create: (options) => open("create", undefined, options),
    resume: (id, options) => open("resume", id, options),
    listRuns: (...args) => call("listRuns", args),
    cancelRun: (...args) => call("cancelRun", args),
    messages: { list: (...args) => call("messages", args) },
  };
}
