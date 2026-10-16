import { NetworkReports } from "@t3tools/client-runtime/network-reports";
import type { NetworkReportNetworkKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

interface NetworkInformationLike extends EventTarget {
  readonly type?: string;
}

function networkInformation(): NetworkInformationLike | undefined {
  return typeof navigator === "undefined"
    ? undefined
    : (navigator as Navigator & { readonly connection?: NetworkInformationLike }).connection;
}

function networkReportKind(type: string | undefined): NetworkReportNetworkKind {
  switch (type) {
    case "wifi":
    case "cellular":
    case "ethernet":
    case "none":
      return type;
    case "bluetooth":
    case "wimax":
    case "mixed":
    case "other":
      return "other";
    default:
      return "unknown";
  }
}

// Only Chromium on Android reports the connection type; elsewhere every
// report says "unknown".
const networkKind = Stream.callback<NetworkReportNetworkKind>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const connection = networkInformation();
      if (connection?.type === undefined) return undefined;
      const listener = () => Queue.offerUnsafe(queue, networkReportKind(connection.type));
      listener();
      connection.addEventListener("change", listener);
      return { connection, listener };
    }),
    (subscription) =>
      Effect.sync(() =>
        subscription?.connection.removeEventListener("change", subscription.listener),
      ),
  ).pipe(Effect.asVoid),
);

// A hidden tab or minimized window is not use, so it ends the current report.
const active = Stream.callback<boolean>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const listener = () => Queue.offerUnsafe(queue, document.visibilityState === "visible");
      listener();
      document.addEventListener("visibilitychange", listener);
      return listener;
    }),
    (listener) => Effect.sync(() => document.removeEventListener("visibilitychange", listener)),
  ).pipe(Effect.asVoid),
);

export const networkReportsPlatformLayer = Layer.succeed(NetworkReports.NetworkReportsPlatform, {
  networkKind,
  active,
  // Web keeps reports in memory; there is no view of them to restore.
  store: { load: Effect.succeedNone, save: () => Effect.void },
});
