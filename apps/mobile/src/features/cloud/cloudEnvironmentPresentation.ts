import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";
import {
  orchestrationProtocolCompatibilityError,
  type EnvironmentConnectionPhase,
} from "@t3tools/client-runtime/connection";
import { relayOfflineReasonMessage } from "@t3tools/client-runtime/relay";

export interface AvailableCloudEnvironmentPresentation {
  readonly connectionError: string | null;
  readonly connectionErrorTraceId: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly statusText: string;
}

export function availableCloudEnvironmentPresentation(input: {
  readonly isStatusPending: boolean;
  readonly status: RelayEnvironmentStatusResponse | null;
  readonly statusError: string | null;
  readonly statusErrorTraceId: string | null;
}): AvailableCloudEnvironmentPresentation {
  const compatibilityError =
    input.status?.descriptor === undefined
      ? null
      : orchestrationProtocolCompatibilityError(input.status.descriptor);
  if (compatibilityError !== null) {
    return {
      connectionError: compatibilityError.message,
      connectionErrorTraceId: null,
      connectionState: "unsupported",
      statusText: "Client not supported",
    };
  }
  if (input.status?.status === "online") {
    return {
      connectionError: null,
      connectionErrorTraceId: null,
      connectionState: "available",
      statusText: "Available · Relay online",
    };
  }

  if (input.status?.status === "offline") {
    const reasonMessage = relayOfflineReasonMessage(input.status);
    // A machine that is simply off or asleep is a normal state, not a failure:
    // the relay's health-check error is diagnostic detail, so it stays hidden.
    if (reasonMessage === null) {
      return {
        connectionError: null,
        connectionErrorTraceId: null,
        connectionState: "available",
        statusText: "Relay offline",
      };
    }
    return {
      connectionError: reasonMessage,
      connectionErrorTraceId: input.status.traceId ?? null,
      connectionState: "error",
      statusText: reasonMessage,
    };
  }

  if (input.statusError) {
    return {
      connectionError: input.statusError,
      connectionErrorTraceId: input.statusErrorTraceId,
      connectionState: "error",
      statusText: input.statusError,
    };
  }

  return {
    connectionError: null,
    connectionErrorTraceId: null,
    connectionState: "available",
    statusText: input.isStatusPending
      ? "Available · Checking relay status..."
      : "Available · Relay status unknown",
  };
}
