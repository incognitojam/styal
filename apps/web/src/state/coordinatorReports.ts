import { createDismissCoordinatorReportCommand } from "@t3tools/client-runtime/coordinator-reports";
import { createReportResponses } from "@t3tools/client-runtime/state/report-responses";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "./threads";

export {
  threadReportResponsesAtom,
  type ReportResponse,
} from "@t3tools/client-runtime/state/report-responses";

export const dismissCoordinatorReport =
  createDismissCoordinatorReportCommand(connectionAtomRuntime);

export const { begin: beginReportResponse, respond: respondToReport } = createReportResponses(
  appAtomRegistry,
  environmentThreadDetails,
);
