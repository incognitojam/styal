import * as Effect from "effect/Effect";

/** Transactional test storage; requests share a snapshot and writers run in order. */
export function makeCloudAuthStorage() {
  const records = new Map<string, unknown>();
  const transactions: Array<{ mode: IDBTransactionMode; writes: Array<string> }> = [];
  let tail = Promise.resolve();
  let beforeCommit: (() => Promise<void>) | null = null;

  function transaction<A>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore, done: (value: A) => void) => void,
  ) {
    return Effect.promise(() => {
      const pending = tail.then(async () => {
        const snapshot = new Map(records);
        const entry = { mode, writes: [] as Array<string> };
        transactions.push(entry);
        const result = await new Promise<A>((resolve) => {
          const store = {
            get: (key: string) => {
              const request = new EventTarget();
              Object.defineProperty(request, "result", { value: snapshot.get(key) });
              queueMicrotask(() => request.dispatchEvent(new Event("success")));
              return request;
            },
            put: (value: unknown, key: string) => {
              entry.writes.push(key);
              snapshot.set(key, value);
            },
            delete: (key: string) => {
              entry.writes.push(key);
              snapshot.delete(key);
            },
          };
          run(store as unknown as IDBObjectStore, resolve);
        });
        const barrier = beforeCommit;
        beforeCommit = null;
        if (barrier) await barrier();
        if (mode === "readwrite") {
          records.clear();
          for (const [key, value] of snapshot) records.set(key, value);
        }
        return result;
      });
      tail = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    });
  }

  return {
    records,
    transactions,
    transaction,
    pauseNextCommit: (barrier: () => Promise<void>) => {
      beforeCommit = barrier;
    },
  };
}

export function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    wait: async () => {
      enter();
      await released;
    },
  };
}
