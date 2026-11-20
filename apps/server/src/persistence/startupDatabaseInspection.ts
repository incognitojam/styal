// @effect-diagnostics nodeBuiltinImport:off -- Inspection runs in a cancellable SQLite worker.
import * as NodeWorkerThreads from "node:worker_threads";
export interface CopySnapshot {
  readonly eventCount: number;
  readonly eventHead: number;
  readonly threadCount: number;
}

// Keep synchronous SQLite off the writer; the caller owns the inspection deadline.
export const inspect = (
  database: string,
  checkpoint = false,
  signal?: AbortSignal,
): Promise<CopySnapshot> =>
  new Promise((resolve, reject) => {
    const worker = new NodeWorkerThreads.Worker(
      `
      const {parentPort,workerData}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite');
      try {
        const db=new DatabaseSync(workerData.database,{readOnly:!workerData.checkpoint});
        db.exec('PRAGMA busy_timeout=5000');
        if(workerData.checkpoint){
          const result=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
          if(result.busy!==0 || result.log!==0 || result.checkpointed!==0) throw new Error('WAL did not fully truncate');
        }
        db.exec("BEGIN");
        const result={
          eventCount:db.prepare('SELECT COUNT(*) AS n FROM orchestration_events').get().n,
          eventHead:db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM orchestration_events').get().n,
          threadCount:db.prepare('SELECT COUNT(*) AS n FROM orchestration_v2_projection_threads').get().n
        };
        db.exec("COMMIT");db.close();parentPort.postMessage({result});
      } catch(error){parentPort.postMessage({error:String(error)});}
    `,
      { eval: true, workerData: { database, checkpoint } },
    );
    let finished = false;
    const complete = async (error: Error | undefined, result?: CopySnapshot) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      await worker.terminate();
      if (error !== undefined) reject(error);
      else if (result !== undefined) resolve(result);
    };
    const abort = () => {
      void complete(new Error("Safety copy interrupted"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message) => {
      void complete(message.error ? new Error(message.error) : undefined, message.result);
    });
    worker.once("error", (error) => {
      void complete(error);
    });
    worker.once("exit", (code) => {
      void complete(new Error(`Safety copy worker exited before completion: ${code}`));
    });
  });
