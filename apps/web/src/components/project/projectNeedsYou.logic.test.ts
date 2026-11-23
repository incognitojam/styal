import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  listProjectNeeds,
  listStoppedThreadNeeds,
  openReports,
  type ThreadNeeds,
} from "./projectNeedsYou.logic";

const local = EnvironmentId.make("env-local");

function shell(id: string, overrides: Partial<EnvironmentThreadShell> = {}) {
  return {
    environmentId: local,
    id: ThreadId.make(id),
    title: id,
    updatedAt: "2026-11-18T09:00:00.000Z",
    ...overrides,
  } as EnvironmentThreadShell;
}

const approval = (id: string, createdAt: string) =>
  ({
    requestId: RuntimeRequestId.make(id),
    requestKind: "command",
    createdAt,
    responseCapability: "live",
  }) as ThreadPendingApproval;
const question = (id: string, createdAt: string) =>
  ({
    requestId: RuntimeRequestId.make(id),
    createdAt,
    questions: [],
  }) as unknown as ThreadPendingUserInput;
const report = (id: string, createdAt: string) => ({
  messageId: MessageId.make(id),
  report: { key: id, title: id, version: 1, question: "Merge?" },
  createdAt,
});

describe("listProjectNeeds", () => {
  it("lists every thread's approvals, questions and report questions together, oldest first", () => {
    const rename = shell("rename");
    const upgrade = shell("upgrade");
    const needs: Record<string, ThreadNeeds> = {
      rename: {
        requests: { approvals: [], userInputs: [question("q1", "2026-11-18T10:03:00.000Z")] },
        reports: [report("r1", "2026-11-18T10:01:00.000Z")],
      },
      upgrade: {
        requests: { approvals: [approval("a1", "2026-11-18T10:02:00.000Z")], userInputs: [] },
        reports: [],
      },
    };
    expect(
      listProjectNeeds([rename, upgrade], (thread) => needs[thread.id] ?? null).map((need) => [
        need.kind,
        need.thread.title,
      ]),
    ).toEqual([
      ["report", "rename"],
      ["approval", "upgrade"],
      ["question", "rename"],
    ]);
  });

  it("keeps a thread waiting on something only its page answers, and skips one still loading", () => {
    const secret = shell("secret", { pendingUserInputAt: "2026-11-18T10:00:00.000Z" });
    const loading = shell("loading");
    const empty: ThreadNeeds = { requests: { approvals: [], userInputs: [] }, reports: [] };
    expect(
      listProjectNeeds([secret, loading], (thread) => (thread === secret ? empty : null)),
    ).toEqual([
      {
        kind: "thread",
        key: `${local}:secret`,
        thread: secret,
        createdAt: secret.pendingUserInputAt,
      },
    ]);
    // Its only question was just answered here; the server still counts it until the answer lands.
    expect(listProjectNeeds([secret], () => ({ ...empty, responding: true }))).toEqual([]);
  });
});

describe("listStoppedThreadNeeds", () => {
  const stopped = (
    id: string,
    failedAt: string,
    overrides: Partial<EnvironmentThreadShell> = {},
    runtime: Partial<NonNullable<EnvironmentThreadShell["runtime"]>> = {},
  ) =>
    shell(id, {
      settledAt: null,
      latestRun: { status: "failed", completedAt: failedAt } as EnvironmentThreadShell["latestRun"],
      runtime: {
        status: "failed",
        lastError: null,
        updatedAt: failedAt,
        ...runtime,
      } as EnvironmentThreadShell["runtime"],
      ...overrides,
    });

  it("lists failures and usage limits oldest first, with the error's first line or the reset", () => {
    expect(
      listStoppedThreadNeeds([
        stopped("crash", "2026-11-18T10:05:00.000Z", {}, { lastError: "  Exit 1\nstack trace" }),
        stopped(
          "limit",
          "2026-11-18T10:01:00.000Z",
          {},
          { lastErrorClass: "usage_limit", usageLimitResetAt: "2026-11-18T15:00:00.000Z" },
        ),
        stopped("silent", "2026-11-18T10:03:00.000Z"),
      ]).map((need) => [
        need.thread.id,
        need.kind,
        need.kind === "failed" ? need.error : need.kind === "limited" ? need.resetAt : null,
      ]),
    ).toEqual([
      ["limit", "limited", "2026-11-18T15:00:00.000Z"],
      ["silent", "failed", null],
      ["crash", "failed", "Exit 1"],
    ]);
  });

  it("drops a thread once it is opened after it stopped or settled", () => {
    const failedAt = "2026-11-18T10:05:00.000Z";
    expect(
      listStoppedThreadNeeds([
        stopped("opened-after", failedAt, { lastVisitedAt: "2026-11-18T10:06:00.000Z" }),
        stopped("settled", failedAt, { settledAt: "2026-11-18T10:07:00.000Z" }),
        stopped("opened-before", failedAt, { lastVisitedAt: "2026-11-18T10:04:00.000Z" }),
        stopped("never-opened", failedAt, { lastVisitedAt: null }),
      ]).map((need) => need.thread.id),
    ).toEqual(["never-opened", "opened-before"]);
    // A server that predates visit marks leaves the field out; this client's own visit counts.
    const older = stopped("older-server", failedAt);
    expect(listStoppedThreadNeeds([older], () => "2026-11-18T10:06:00.000Z")).toEqual([]);
  });
});

describe("openReports", () => {
  it("keeps only report questions still waiting for an answer", () => {
    const at = (minute: number) => DateTime.makeUnsafe(`2026-11-18T10:0${minute}:00.000Z`);
    const tagged = (id: string, minute: number, question?: string) => ({
      id: MessageId.make(id),
      role: "assistant",
      text: "Report",
      createdAt: at(minute),
      report: { key: id, title: id, version: 1, ...(question ? { question } : {}) },
    });
    const projection = {
      thread: {
        reportDismissals: [
          { messageId: MessageId.make("dismissed"), key: "dismissed", version: 1 },
        ],
      },
      messages: [
        tagged("open", 1, "Keep the old names?"),
        tagged("posted", 2),
        tagged("answered", 3, "Merge?"),
        tagged("dismissed", 4, "Ship?"),
        {
          id: MessageId.make("reply"),
          role: "user",
          text: "Yes",
          createdAt: at(5),
          reportAnswer: { messageId: MessageId.make("answered"), key: "answered", version: 1 },
        },
      ],
    } as unknown as Pick<OrchestrationV2ThreadProjection, "messages" | "thread">;
    expect(openReports(projection)).toEqual([
      {
        messageId: "open",
        report: { key: "open", title: "open", version: 1, question: "Keep the old names?" },
        createdAt: "2026-11-18T10:01:00.000Z",
      },
    ]);
    // An answer or dismissal this client is still sending takes the question off at once.
    const openRef = { messageId: MessageId.make("open"), key: "open", version: 1 };
    for (const pending of [
      {
        ref: openRef,
        kind: "answer" as const,
        messageId: MessageId.make("pending-reply"),
        text: "[open, version 1] Yes",
        createdAt: "2026-11-18T10:06:00.000Z",
      },
      { ref: openRef, kind: "dismiss" as const },
    ]) {
      expect(openReports(projection, [pending])).toEqual([]);
    }
  });
});
