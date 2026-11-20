import {
  createDismissCoordinatorReportCommand,
  reportResponseOutcomeUnknown,
} from "@t3tools/client-runtime/coordinator-reports";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import {
  createReportResponses,
  threadReportResponsesAtom,
  type ReportResponse,
} from "@t3tools/client-runtime/state/report-responses";
import type { ScopedThreadRef } from "@t3tools/contracts";
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
  response.kind === "dismiss"
    ? "Could not dismiss the report"
    : response.reply === undefined
      ? "Could not send your answer"
      : "Could not send your reply";

export const { begin: beginReportResponse, respond: respondToReport } = createReportResponses(
  appAtomRegistry,
  {
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
  },
);

/** Whether `thread` has a typed reply with exactly this text whose send outcome is unknown. */
export const hasUnconfirmedReply = (thread: ScopedThreadRef, text: string) =>
  text.trim() !== "" &&
  appAtomRegistry
    .get(threadReportResponsesAtom(threadKey(thread)))
    .some(
      (response) =>
        response.kind === "answer" &&
        response.reply === text &&
        reportResponseOutcomeUnknown(response),
    );
