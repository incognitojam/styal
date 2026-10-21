import { EnvironmentId } from "@t3tools/contracts";
import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";
import { describe, expect, it } from "vite-plus/test";

import { availableCloudEnvironmentPresentation } from "./cloudEnvironmentPresentation";

function relayStatus(
  status: RelayEnvironmentStatusResponse["status"],
  error?: string,
  traceId?: string,
): RelayEnvironmentStatusResponse {
  return {
    environmentId: EnvironmentId.make("environment-cloud"),
    endpoint: {
      httpBaseUrl: "https://cloud.example.test/",
      wsBaseUrl: "wss://cloud.example.test/ws",
      providerKind: "cloudflare_tunnel",
    },
    status,
    checkedAt: "2026-06-05T16:49:11.000Z",
    ...(error ? { error } : {}),
    ...(traceId ? { traceId } : {}),
  };
}

describe("available cloud environment presentation", () => {
  it("shows an offline relay without marking the row as failing", () => {
    expect(
      availableCloudEnvironmentPresentation({
        isStatusPending: false,
        status: relayStatus("offline", "Tunnel is unavailable.", "trace-offline"),
        statusError: null,
        statusErrorTraceId: null,
      }),
    ).toEqual({
      connectionError: "Tunnel is unavailable.",
      connectionErrorTraceId: "trace-offline",
      connectionState: "available",
      statusText: "Tunnel is unavailable.",
    });
  });

  it("tells the user to update a host whose idle tunnel was removed", () => {
    const status = {
      ...relayStatus("offline", "Managed endpoint health request failed.", "trace-released"),
      offlineReason: "tunnel_released",
    } satisfies RelayEnvironmentStatusResponse;
    expect(
      availableCloudEnvironmentPresentation({
        isStatusPending: false,
        status,
        statusError: null,
        statusErrorTraceId: null,
      }),
    ).toMatchObject({
      connectionState: "available",
      statusText:
        "Offline for a while, so its styal Link tunnel was removed. Start styal on that computer and update it to the latest version to reconnect.",
      connectionErrorTraceId: "trace-released",
    });
  });
});
