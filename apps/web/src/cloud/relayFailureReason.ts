import { ManagedRelay, relayRequestFailureDetail } from "@t3tools/client-runtime/relay-session";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m } from "../i18n/messages";

const isRequestFailed = Schema.is(ManagedRelay.ManagedRelayRequestFailedError);
const isRequestTimeout = Schema.is(ManagedRelay.ManagedRelayRequestTimeoutError);

/** One short line for an error toast saying why a styal Link request failed. */
export function relayFailureReason(cause: unknown): string | null {
  for (let current = cause, depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if (isRequestTimeout(current)) return m(msg("styal Link timed out. Try again."));
    if (isRequestFailed(current)) {
      if (current.transportFailed) return m(msg("Could not reach styal Link. Check your network."));
      if (current.relayError) {
        return current.relayError._tag === "RelayInternalError"
          ? m(msg("styal Link is unavailable. Try again."))
          : relayRequestFailureDetail(current);
      }
      if (current.status === 504) return m(msg("styal Link timed out. Try again."));
      if ((current.status ?? 0) >= 500) return m(msg("styal Link is unavailable. Try again."));
      return relayRequestFailureDetail(current);
    }
    current = current.cause;
  }
  return null;
}
