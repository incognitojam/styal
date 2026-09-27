import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** The server received the command and decided it failed. */
export const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "deleted"
  );
}
