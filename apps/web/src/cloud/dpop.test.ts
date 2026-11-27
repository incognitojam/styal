import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, vi } from "vite-plus/test";
import * as Dpop from "./dpop";
afterEach(() => vi.unstubAllGlobals());

/** Reproduces native request errors bubbling before a successful transaction completes. */
function keyStorage(
  existing: Dpop.BrowserDpopKey,
  failure = "ConstraintError",
  forceBubble = false,
) {
  const requestError = vi.fn();
  const transactionError = vi.fn();
  const database = {
    close: vi.fn(),
    transaction: (_store: string, mode: IDBTransactionMode) => {
      const transaction = new EventTarget();
      Object.assign(transaction, { error: null });
      transaction.addEventListener("error", transactionError);
      const store = {
        add: () => {
          const request = new EventTarget();
          Object.assign(request, { error: new DOMException("Synthetic key write error", failure) });
          queueMicrotask(() => {
            const event = new Event("error", { cancelable: true, bubbles: true });
            let stopped = false;
            event.stopPropagation = () => {
              stopped = true;
            };
            request.addEventListener("error", requestError);
            request.dispatchEvent(event);
            if (!stopped || forceBubble) {
              // Bubbling preserves the request as target; dispatchEvent alone retargets it.
              Object.defineProperty(event, "target", { value: request });
              transaction.dispatchEvent(event);
            }
            transaction.dispatchEvent(new Event(event.defaultPrevented ? "complete" : "abort"));
          });
          return request;
        },
        get: () => {
          expect(mode).toBe("readonly");
          const request = new EventTarget();
          Object.assign(request, { result: existing });
          queueMicrotask(() => request.dispatchEvent(new Event("success")));
          return request;
        },
      };
      Object.assign(transaction, { objectStore: () => store });
      return transaction;
    },
  };
  vi.stubGlobal("indexedDB", {
    open: () => {
      const request = new EventTarget();
      Object.assign(request, { result: database });
      queueMicrotask(() => request.dispatchEvent(new Event("success")));
      return request;
    },
  });
  return { requestError, transactionError, close: database.close };
}

describe("concurrent browser DPoP key creation", () => {
  it.effect("keeps and re-reads the stored winner after a duplicate add", () =>
    Effect.gen(function* () {
      const winner = yield* Dpop.generateBrowserDpopKey;
      const loser = yield* Dpop.generateBrowserDpopKey;
      const storage = keyStorage(winner);
      expect(yield* Dpop.writeStoredBrowserDpopKey(loser)).toBe(winner);
      expect(storage.requestError).toHaveBeenCalledOnce();
      expect(storage.transactionError).not.toHaveBeenCalled();
      expect(storage.close).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("also tolerates an already-handled constraint error at the transaction listener", () =>
    Effect.gen(function* () {
      const winner = yield* Dpop.generateBrowserDpopKey;
      const storage = keyStorage(winner, "ConstraintError", true);
      expect(yield* Dpop.writeStoredBrowserDpopKey(winner)).toBe(winner);
      expect(storage.transactionError).toHaveBeenCalledOnce();
    }),
  );

  it.effect("still fails a genuine write error", () =>
    Effect.gen(function* () {
      const key = yield* Dpop.generateBrowserDpopKey;
      keyStorage(key, "UnknownError");
      const result = yield* Dpop.writeStoredBrowserDpopKey(key).pipe(Effect.flip);
      expect(result).toBeInstanceOf(Dpop.BrowserDpopError);
    }),
  );
});
