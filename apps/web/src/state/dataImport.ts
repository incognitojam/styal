import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const legacyImportPreview = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:server:legacy-import-preview",
  tag: WS_METHODS.serverPreviewLegacyImport,
  // Reopening Import data must immediately reflect projects added to or removed
  // from this styal environment while the page was closed.
  staleTimeMs: 0,
  // The old app writes its own database, so there is no orchestration event to
  // invalidate this query. Refresh only while the import page is subscribed.
  refreshIntervalMs: 5_000,
});

export const importLegacyData = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:server:legacy-import",
  tag: WS_METHODS.serverImportLegacyData,
  concurrency: {
    mode: "singleFlight",
    key: ({ environmentId }) => environmentId,
  },
});
