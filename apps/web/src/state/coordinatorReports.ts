import { createDismissCoordinatorReportCommand } from "@t3tools/client-runtime/coordinator-reports";
import {
  createReportResponses,
  type ReportResponse,
} from "@t3tools/client-runtime/state/report-responses";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { environmentThreadDetails, threadEnvironment } from "./threads";

export {
  threadReportResponsesAtom,
  type ReportResponse,
} from "@t3tools/client-runtime/state/report-responses";

export const dismissCoordinatorReport =
  createDismissCoordinatorReportCommand(connectionAtomRuntime);

const failedTitle = (response: ReportResponse) =>
  response.kind === "dismiss" ? "Could not dismiss the report" : "Could not send your answer";

export const { respond: respondToReport } = createReportResponses(appAtomRegistry, {
  stateAtom: environmentThreadDetails.stateAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
  onFailed: (response, detail) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: failedTitle(response),
        description: detail ?? "Failed to send message.",
      }),
    ),
});
