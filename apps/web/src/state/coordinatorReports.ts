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
import type { AnyRouter } from "@tanstack/react-router";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { buildThreadRouteParams, isThreadRoutePathname } from "../threadRoutes";
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

let router: AnyRouter | null = null;
/** Lets a failure toast shown away from its thread open it; the router exists once the app starts. */
export const startReportResponseToasts = (appRouter: AnyRouter) => {
  router = appRouter;
};

export const { begin: beginReportResponse, respond: respondToReport } = createReportResponses(
  appAtomRegistry,
  {
    stateAtom: environmentThreadDetails.stateAtom,
    snapshotAtom: threadEnvironment.snapshotAtom,
    onFailed: (thread, response, detail) => {
      const elsewhere =
        router !== null && !isThreadRoutePathname(router.state.location.pathname, thread);
      const id = toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failedTitle(response),
          description: detail ?? "Failed to send message.",
          ...(elsewhere
            ? {
                actionProps: {
                  children: "Open thread",
                  onClick: () => {
                    toastManager.close(id);
                    void router?.navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(thread),
                    });
                  },
                },
              }
            : {}),
        }),
      );
    },
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
