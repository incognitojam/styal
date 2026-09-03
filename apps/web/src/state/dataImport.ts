import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type LegacyImportRequest, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const legacyImportPreview = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:server:legacy-import-preview",
  tag: WS_METHODS.serverPreviewLegacyImport,
  // Reopening Import data must immediately reflect projects added to or removed
  // from this styal environment while the page was closed.
  staleTimeMs: 0,
  // The old app writes its own database, so there is no orchestration event to
  // invalidate this query. Refresh only while the import page is subscribed,
  // and keep the interval modest because a scan reads both databases.
  refreshIntervalMs: 30_000,
});

export function legacyImportRequestKey(target: {
  readonly environmentId: EnvironmentId;
  readonly input: LegacyImportRequest;
}): string {
  return JSON.stringify([target.environmentId, target.input]);
}

export const legacyImportPendingCount = Atom.make(0).pipe(
  Atom.keepAlive,
  Atom.withLabel("environment-data:server:legacy-import-pending"),
);

const importLegacyDataRpc = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:server:legacy-import",
  tag: WS_METHODS.serverImportLegacyData,
  concurrency: {
    mode: "singleFlight",
    key: legacyImportRequestKey,
  },
});

export const importLegacyData: typeof importLegacyDataRpc = {
  ...importLegacyDataRpc,
  run: async (registry, target) => {
    registry.update(legacyImportPendingCount, (count) => count + 1);
    try {
      return await importLegacyDataRpc.run(registry, target);
    } finally {
      registry.update(legacyImportPendingCount, (count) => Math.max(0, count - 1));
    }
  },
};
