// @effect-diagnostics nodeBuiltinImport:off
import * as NodeWorkerThreads from "node:worker_threads";
import * as Data from "effect/Data";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import type { ServerStartupCopyProgress } from "@t3tools/contracts";

export class StartupCopyLimit extends Data.TaggedError("StartupCopyLimit")<{
  readonly reason: "stalled" | "deadline";
}> {}
export class StartupCopyIoError extends Data.TaggedError("StartupCopyIoError")<{
  readonly cause: unknown;
}> {}

// Stop after 60 s without bytes; total budget is max(15 min, size at 20,000,000 bytes/s).
const copyBudgetMs = (bytes: number) => Math.max(15 * 60_000, (bytes / 20_000_000) * 1000);

export const withCopyBudget = Effect.fn("StartupFileCopy.withBudget")(function* <A, E, R>(
  totalBytes: number,
  work: (progress: (bytes: number) => void) => Effect.Effect<A, E, R>,
  report: (progress: ServerStartupCopyProgress) => Effect.Effect<void> = () => Effect.void,
) {
  const clock = yield* Clock.Clock;
  const now = () => Number(clock.monotonicTimeNanosUnsafe() / 1_000_000n);
  const startedAt = now();
  const deadline = startedAt + copyBudgetMs(totalBytes);
  const changes = yield* Queue.unbounded<{ bytes: number; at: number }>();
  let lastMovedAt = startedAt;
  let copiedBytes = 0;
  const publish = () =>
    report({
      phase: "copying",
      copiedBytes,
      totalBytes,
      leaseMs: Math.max(0, Math.min(60_000 - (now() - lastMovedAt), deadline - now())),
    });
  yield* publish();
  const observe = Effect.gen(function* () {
    while (true) {
      const left = 60_000 - (now() - lastMovedAt);
      const next = yield* Queue.take(changes).pipe(Effect.timeoutOption(Math.max(0, left)));
      if (Option.isNone(next)) return yield* new StartupCopyLimit({ reason: "stalled" });
      if (next.value.bytes > copiedBytes) {
        copiedBytes = next.value.bytes;
        lastMovedAt = next.value.at;
        yield* publish();
      }
    }
  });
  return yield* Effect.raceFirst(
    work((bytes) => {
      Queue.offerUnsafe(changes, { bytes, at: now() });
    }),
    observe,
  ).pipe(
    Effect.timeoutOrElse({
      duration: copyBudgetMs(totalBytes),
      orElse: () => Effect.fail(new StartupCopyLimit({ reason: "deadline" })),
    }),
  );
});

export const streamDatabaseFile = Effect.fn("StartupFileCopy.stream")(function* (
  source: string,
  destination: string,
  progress: (bytes: number) => void,
) {
  const messages = yield* Queue.unbounded<
    | { readonly type: "progress"; readonly bytes: number }
    | { readonly type: "done" }
    | { readonly type: "error"; readonly cause: unknown }
  >();
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const worker = new NodeWorkerThreads.Worker(
          `
        const fs=require('node:fs');
        const {parentPort,workerData:o}=require('node:worker_threads');
        let input,output;
        try {
          input=fs.openSync(o.source,'r');output=fs.openSync(o.destination,'wx',0o600);
          const buffer=Buffer.allocUnsafe(1024*1024);
          let copied=0,synced=0;
          while(true) {
            const read=fs.readSync(input,buffer,0,buffer.length,null);
            if(read===0)break;
            let written=0;
            while(written<read){const n=fs.writeSync(output,buffer,written,read-written);if(n===0)throw new Error('zero-byte write');written+=n;copied+=n;parentPort.postMessage({type:'progress',bytes:copied});}
            if(copied-synced>=32*1024*1024){fs.fsyncSync(output);synced=copied;}
          }
          fs.fsyncSync(output);fs.closeSync(output);output=undefined;fs.closeSync(input);input=undefined;
          parentPort.postMessage({type:'done'});
        }catch(error){parentPort.postMessage({type:'error',cause:String(error)});}
        finally{if(input!==undefined)fs.closeSync(input);if(output!==undefined)fs.closeSync(output);}
      `,
          {
            eval: true,
            workerData: {
              source,
              destination,
            },
          },
        );
        worker.on("message", (message) => Queue.offerUnsafe(messages, message));
        worker.once("error", (cause) => Queue.offerUnsafe(messages, { type: "error", cause }));
        worker.once("exit", (code) =>
          Queue.offerUnsafe(messages, { type: "error", cause: `Copy worker exited (${code})` }),
        );
        return worker;
      },
      catch: (cause) => new StartupCopyIoError({ cause }),
    }),
    (worker) => Effect.promise(() => worker.terminate()).pipe(Effect.asVoid),
  );
  while (true) {
    const message = yield* Queue.take(messages);
    if (message.type === "error") return yield* new StartupCopyIoError({ cause: message.cause });
    if (message.type === "done") return;
    progress(message.bytes);
  }
});
