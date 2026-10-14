import { PreviewAutomationFailureReason } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isFailureReason = Schema.is(PreviewAutomationFailureReason);

function errorField(error: unknown, key: string): unknown {
  try {
    return typeof error === "object" && error !== null ? Reflect.get(error, key) : undefined;
  } catch {
    return undefined;
  }
}

/** Inspect structured errors locally; only a fixed code leaves the browser boundary. */
export function previewAutomationFailureReason(
  error: unknown,
): PreviewAutomationFailureReason | undefined {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && error !== undefined && !seen.has(error); depth += 1) {
    seen.add(error);
    for (const candidate of [
      errorField(error, "code"),
      errorField(error, "name"),
      errorField(errorField(error, "exception"), "className"),
    ]) {
      if (isFailureReason(candidate)) return candidate;
    }
    const message = errorField(error, "message");
    // Electron drops error fields across invoke IPC. Desktop wrappers append this
    // token before crossing IPC; never infer a kind from arbitrary page messages.
    if (
      typeof message === "string" &&
      message.length <= 4_096 &&
      message.startsWith("Error invoking remote method '")
    ) {
      const reason = / \[styal-preview-reason=([A-Za-z_]+)\]$/.exec(message)?.[1];
      if (isFailureReason(reason)) return reason;
    }
    error = errorField(error, "cause");
  }
  return undefined;
}

/** Preserve the safe classification in the only error field Electron IPC retains. */
export function previewAutomationFailureReasonSuffix(cause: unknown): string {
  const reason = previewAutomationFailureReason(cause);
  return reason === undefined ? "" : ` [styal-preview-reason=${reason}]`;
}
