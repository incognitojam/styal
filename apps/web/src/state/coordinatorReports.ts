import { createDismissCoordinatorReportCommand } from "@t3tools/client-runtime/coordinator-reports";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import {
  createReportResponses,
  threadReportResponsesAtom,
} from "@t3tools/client-runtime/state/report-responses";
import type { ScopedThreadRef } from "@t3tools/contracts";
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

/** Whether `thread` has a typed reply with this text that the server has not confirmed yet. */
export const hasUnconfirmedReply = (thread: ScopedThreadRef, text: string) =>
  appAtomRegistry
    .get(threadReportResponsesAtom(threadKey(thread)))
    .some(
      (response) =>
        response.kind === "answer" &&
        response.reply === true &&
        response.failed === undefined &&
        response.text.endsWith(text),
    );
