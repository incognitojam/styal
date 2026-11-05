// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no randomUUID helper.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  FEEDBACK_REPORT_TOOL_NAME,
  FEEDBACK_REPOSITORY,
  PROVIDER_DISPLAY_NAMES,
  RuntimeRequestId,
  type FeedbackAgentReportResult,
  type FeedbackApprovalReport,
  type FeedbackDraft,
  type FeedbackSubmitResult,
  type NodeId,
  type ProviderDriverKind,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { SourceControlDrivers } from "../sourceControl/builtInDrivers.ts";

const FEEDBACK_HOST = "github.com";
const APPROVAL_TIMEOUT = Duration.minutes(10);
const APPROVAL_POLL_INTERVAL = Duration.seconds(1);
// Browsers and GitHub reject very long URLs. Percent-encoding can triple the length of the text.
const MANUAL_URL_MAX_BODY_LENGTH = 2_500;

/**
 * The bug form is the only form anyone can open with values filled in: blank issues are off, and
 * forms take values by field id rather than `body`.
 */
export const manualIssueUrl = (title: string, body: string) => {
  const params = new URLSearchParams({
    template: "bug_report.yml",
    title,
    actual:
      body.length > MANUAL_URL_MAX_BODY_LENGTH
        ? `${body.slice(0, MANUAL_URL_MAX_BODY_LENGTH)}\n\n(shortened to fit in a link)`
        : body,
  });
  return `https://${FEEDBACK_HOST}/${FEEDBACK_REPOSITORY}/issues/new?${params.toString()}`;
};

export class FeedbackService extends Context.Service<
  FeedbackService,
  {
    /** Files what the user wrote. Reaching this method is their confirmation. */
    readonly submit: (draft: FeedbackDraft) => Effect.Effect<FeedbackSubmitResult>;
    /** Shows an agent's report to the user in its thread, and files it only if they approve. */
    readonly reportFromAgent: (
      threadId: ThreadId,
      draft: FeedbackDraft,
    ) => Effect.Effect<FeedbackAgentReportResult>;
  }
>()("@styal/cli/feedback/FeedbackService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const drivers = yield* SourceControlDrivers;
  const issueFiling = drivers.find(({ driver }) => driver.kind === "github")?.instance.issueFiling;
  const account = issueFiling?.account(FEEDBACK_HOST) ?? Effect.succeed(null);
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;

  const composeBody = (draft: FeedbackDraft, author: string) =>
    [
      draft.body,
      "",
      "---",
      `styal ${packageJson.version} (${ServerConfig.telemetryChannel}), ${platform} ${architecture}`,
      author,
    ].join("\n");

  const notFiled = (title: string, body: string, reason: string) =>
    ({ status: "not_filed", reason, manualUrl: manualIssueUrl(title, body) }) as const;

  const file = Effect.fn("FeedbackService.file")(function* (title: string, body: string) {
    if (issueFiling === undefined) {
      return notFiled(title, body, "This server cannot file GitHub issues.");
    }
    const result = yield* issueFiling.file({
      host: FEEDBACK_HOST,
      repository: FEEDBACK_REPOSITORY,
      title,
      body,
    });
    return result.status === "filed"
      ? ({ status: "filed", issueUrl: result.url } as const)
      : notFiled(title, body, result.reason);
  });

  /** Opening and closing are one acquire/release pair, so however the call ends, the card closes. */
  const requestApproval = Effect.fn("FeedbackService.requestApproval")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly rootNodeId: NodeId;
    readonly prompt: string;
    readonly toolInput: FeedbackApprovalReport;
  }) {
    const requestId = RuntimeRequestId.make(`runtime-request:feedback:${NodeCrypto.randomUUID()}`);
    const record = (approvalStatus: "pending" | "cancelled") =>
      threads.dispatch({
        type: "server_approval.record",
        commandId: CommandId.make(`feedback-approval:${requestId}:${approvalStatus}`),
        threadId: input.threadId,
        runId: input.runId,
        nodeId: input.rootNodeId,
        requestId,
        approvalStatus,
        toolName: FEEDBACK_REPORT_TOOL_NAME,
        toolInput: input.toolInput,
        prompt: input.prompt,
        options: [
          { decision: "accept", label: "Post publicly" },
          { decision: "decline", label: "Don't post" },
        ],
      });
    const wait = Effect.gen(function* () {
      while (true) {
        const projection = yield* threads
          .getThreadRecords(input.threadId, ["runtimeRequests", "runs"])
          .pipe(Effect.orElseSucceed(() => null));
        const request = projection?.runtimeRequests.find((candidate) => candidate.id === requestId);
        if (request !== undefined && request.status !== "pending") {
          return request.status === "resolved" ? (request.decision ?? "decline") : "unanswered";
        }
        const live = projection?.runs.find((candidate) => candidate.id === input.runId);
        if (live !== undefined && !ThreadManagementService.isActiveRun(live)) return "unanswered";
        yield* Effect.sleep(APPROVAL_POLL_INTERVAL);
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: APPROVAL_TIMEOUT,
        orElse: () => Effect.succeed("unanswered" as const),
      }),
    );
    return yield* Effect.acquireUseRelease(
      record("pending"),
      () => wait,
      () => record("cancelled").pipe(Effect.ignore),
    );
  });

  const submit: FeedbackService["Service"]["submit"] = Effect.fn("FeedbackService.submit")(
    function* (draft) {
      return yield* file(draft.title, composeBody(draft, "Sent from styal by the user."));
    },
  );

  const reportFromAgent: FeedbackService["Service"]["reportFromAgent"] = Effect.fn(
    "FeedbackService.reportFromAgent",
  )(function* (threadId, draft) {
    const records = yield* threads
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.orElseSucceed(() => null));
    const run = records === null ? undefined : ThreadManagementService.latestActiveRun(records);
    const model = records?.thread.modelSelection;
    // A custom instance's id is the user's own name for it, so it stays out of the public issue.
    const provider = PROVIDER_DISPLAY_NAMES[model?.instanceId as ProviderDriverKind];
    const body = composeBody(
      draft,
      model === undefined
        ? "Written by an agent and approved by the user."
        : `Written by an agent (${provider === undefined ? "" : `${provider}, `}${model.model}) and approved by the user.`,
    );
    const login = yield* account;
    if (login === null) {
      return notFiled(draft.title, body, "This server has no GitHub sign-in.");
    }
    if (run === undefined || run.rootNodeId === null) {
      return notFiled(draft.title, body, "The user's approval can only be asked during a turn.");
    }
    const decision = yield* requestApproval({
      threadId,
      runId: run.id,
      rootNodeId: run.rootNodeId,
      prompt: `Post this as a public issue on ${FEEDBACK_REPOSITORY} as @${login}?\n\n${draft.title}\n\n${body}`,
      toolInput: {
        title: draft.title,
        body,
        repository: FEEDBACK_REPOSITORY,
        account: login,
      },
    }).pipe(Effect.orElseSucceed(() => "failed" as const));
    switch (decision) {
      case "accept":
        return yield* file(draft.title, body);
      case "failed":
        return notFiled(draft.title, body, "Could not ask the user for approval.");
      case "unanswered":
        return { status: "not_answered" } as const;
      default:
        return { status: "declined" } as const;
    }
  });

  return FeedbackService.of({ submit, reportFromAgent });
});

export const layer = Layer.effect(FeedbackService, make);
