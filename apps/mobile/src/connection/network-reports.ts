import { NetworkReports } from "@t3tools/client-runtime/network-reports";
import type { NetworkReportNetworkKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Network from "expo-network";
import { AppState } from "react-native";

import { writeFileAtomically } from "../lib/atomic-file";

const NETWORK_REPORTS_FILE = "network-reports.json";

/** The interface type only; expo-network's details (SSID, carrier) are never read. */
export function networkReportKind(state: Network.NetworkState): NetworkReportNetworkKind {
  if (state.isConnected === false) return "none";
  switch (state.type) {
    case Network.NetworkStateType.WIFI:
      return "wifi";
    case Network.NetworkStateType.CELLULAR:
      return "cellular";
    case Network.NetworkStateType.ETHERNET:
      return "ethernet";
    case Network.NetworkStateType.VPN:
      return "vpn";
    case Network.NetworkStateType.NONE:
      return "none";
    case Network.NetworkStateType.BLUETOOTH:
    case Network.NetworkStateType.WIMAX:
    case Network.NetworkStateType.OTHER:
      return "other";
    case Network.NetworkStateType.UNKNOWN:
    case undefined:
      return "unknown";
  }
}

// expo-network reports "none" when a network is lost even if another one takes
// over a moment later, and on Android 13+ can still describe the lost network
// right after it goes. A dead zone lasts longer than a handover, so each change
// waits for the state to settle and then reads it afresh.
const NETWORK_SETTLE_MS = 1_500;

const networkKind = Stream.callback<NetworkReportNetworkKind>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let latestRead = 0;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      const read = () => {
        const thisRead = ++latestRead;
        void Network.getNetworkStateAsync()
          .then((state) => {
            if (thisRead === latestRead) Queue.offerUnsafe(queue, networkReportKind(state));
          })
          .catch(() => undefined);
      };
      const settle = () => {
        if (settleTimer !== undefined) clearTimeout(settleTimer);
        settleTimer = setTimeout(read, NETWORK_SETTLE_MS);
      };
      read();
      const network = Network.addNetworkStateListener(settle);
      // Changes while the app was in the background may never be delivered.
      const appState = AppState.addEventListener("change", (state) => {
        if (state === "active") settle();
      });
      return () => {
        latestRead += 1;
        if (settleTimer !== undefined) clearTimeout(settleTimer);
        network.remove();
        appState.remove();
      };
    }),
    (stop) => Effect.sync(stop),
  ).pipe(Effect.asVoid),
);

// iOS reports "inactive" while the app is still on screen, such as under
// Control Center, so only the background ends foreground use.
const active = Stream.callback<boolean>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      Queue.offerUnsafe(queue, AppState.currentState !== "background");
      return AppState.addEventListener("change", (state) => {
        Queue.offerUnsafe(queue, state !== "background");
      });
    }),
    (subscription) => Effect.sync(() => subscription.remove()),
  ).pipe(Effect.asVoid),
);

async function reportsFile() {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.document, NETWORK_REPORTS_FILE);
}

const store = {
  load: Effect.tryPromise(async () => {
    const file = await reportsFile();
    return file.exists ? Option.some(await file.text()) : Option.none<string>();
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not read saved network reports.", { cause }).pipe(
        Effect.as(Option.none<string>()),
      ),
    ),
  ),
  save: (document: string) =>
    Effect.tryPromise(async () => writeFileAtomically(await reportsFile(), document)).pipe(
      Effect.catch((cause) => Effect.logWarning("Could not save network reports.", { cause })),
    ),
};

export const networkReportsPlatformLayer = Layer.succeed(NetworkReports.NetworkReportsPlatform, {
  networkKind,
  active,
  store,
});
