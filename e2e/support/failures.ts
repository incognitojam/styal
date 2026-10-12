import { beforeEach } from "vite-plus/test";

type FailureHandler = () => Promise<void>;

const handlers = new Set<FailureHandler>();
let failed = false;

/** Whether a test in this file has failed. Environments keep their state when one has. */
export function hasTestFailed(): boolean {
  return failed;
}

/** Records a failure outside a test, such as an environment that fails to start in `beforeAll`. */
export function markFailed(): void {
  failed = true;
}

/** Runs `handler` when a test in this file fails, such as to take a screenshot. */
export function onTestFailure(handler: FailureHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Registered through `setupFiles`, so every test file reports its failures. */
export function registerFailureHooks(): void {
  beforeEach(({ onTestFailed }) => {
    onTestFailed(async () => {
      failed = true;
      for (const handler of handlers) await handler().catch(() => {});
    });
  });
}
