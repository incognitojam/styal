import {
  CommandId,
  type MessageId,
  type OrchestrationV2MentionedTimeSpan,
  type ThreadId,
} from "@t3tools/contracts";
import type { MentionedTimesCheckResult } from "@t3tools/provider-core/server/textGeneration";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  findMentionedTimeSpans,
  markMentionedTimeSpans,
  type MentionedTimeSpan,
} from "@t3tools/shared/mentionedTimeSpans";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { hostTimeZone } from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as FeatureUsage from "../telemetry/FeatureUsage.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/** The model's answers keyed back to the spans it was shown; malformed fields are dropped. */
function mentionedTimeSpansFromCheck(
  spans: ReadonlyArray<MentionedTimeSpan>,
  result: MentionedTimesCheckResult,
): OrchestrationV2MentionedTimeSpan[] {
  const answers = new Map(result.spans.map((answer) => [answer.span, answer]));
  return spans.flatMap((span, index): OrchestrationV2MentionedTimeSpan[] => {
    const answer = answers.get(index + 1);
    if (answer === undefined) return [];
    if (answer.kind !== "moment") return [{ ...span, kind: answer.kind }];
    const zone = answer.zone?.trim();
    return [
      {
        ...span,
        kind: "moment" as const,
        ...(answer.time !== null && TIME.test(answer.time) ? { time: answer.time } : {}),
        ...(zone ? { zone } : {}),
        ...(answer.date !== null && DATE.test(answer.date) ? { date: answer.date } : {}),
      },
    ];
  });
}

function wallClock(instant: DateTime.Utc, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(DateTime.toDate(instant));
}

export class MentionedTimesCheckService extends Context.Service<
  MentionedTimesCheckService,
  {
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
    }) => Effect.Effect<void>;
  }
>()("@styal/cli/orchestration-v2/MentionedTimesCheckService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const analytics = yield* Effect.serviceOption(AnalyticsService.AnalyticsService);

  const check = Effect.fn("MentionedTimesCheckService.check")(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) {
    const settings = yield* serverSettings.getSettings;
    if (!settings.mentionedTimeCheckEnabled) return;
    const projection = yield* threads.getThreadRecords(input.threadId, ["messages"], {
      messageIds: [input.messageId],
    });
    // Subagent threads are hidden and rarely read; checking them would multiply the cost.
    if (projection.thread.lineage.relationshipToParent === "subagent") return;
    const message = projection.messages.find((candidate) => candidate.id === input.messageId);
    if (
      message === undefined ||
      message.role !== "assistant" ||
      message.streaming ||
      message.mentionedTimes !== undefined
    ) {
      return;
    }
    const spans = findMentionedTimeSpans(message.text);
    if (spans.length === 0) return;
    const project = yield* projects.get(projection.thread.projectId);
    if (Option.isNone(project)) return;

    const timeZone = hostTimeZone() ?? "UTC";
    const request = textGeneration.checkMentionedTimes({
      cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
      markedMessage: markMentionedTimeSpans(message.text, spans),
      writtenAt: wallClock(message.createdAt, timeZone),
      timeZone,
      modelSelection:
        settings.mentionedTimeCheckModelSelection ??
        resolveProjectSettings(settings, projection.thread.projectId).settings
          .textGenerationModelSelection,
    });
    const result = yield* Option.match(analytics, {
      onNone: () => request,
      onSome: (service) =>
        FeatureUsage.observe(
          { feature: "mentioned-time-check", action: "check", source: "system" },
          request,
        ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, service)),
    });

    const checkedAt = yield* DateTime.now;
    const commandId = CommandId.make(`command:effect:message.mentioned-times.check:${message.id}`);
    yield* eventSink.commitCommand({
      commandId,
      threadId: input.threadId,
      commandType: "message.mentioned-times.check",
      acceptedAt: checkedAt,
      effects: [],
      events: [
        {
          id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
          type: "message.mentioned-times-checked",
          threadId: input.threadId,
          ...(message.runId === null ? {} : { runId: message.runId }),
          occurredAt: checkedAt,
          payload: {
            messageId: message.id,
            mentionedTimes: {
              checkedAt: DateTime.formatIso(checkedAt),
              spans: mentionedTimeSpansFromCheck(spans, result),
            },
          },
        },
      ],
    });
  });

  // One attempt: a failed check leaves the rules' chips, which are right most of the time.
  const execute: MentionedTimesCheckService["Service"]["execute"] = (input) =>
    check(input).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Mentioned time check failed", { ...input, cause }),
      ),
    );

  return MentionedTimesCheckService.of({ execute });
});

export const layer = Layer.effect(MentionedTimesCheckService, make);
