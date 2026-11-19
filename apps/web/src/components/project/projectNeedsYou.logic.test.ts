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
  openReports,
  type ThreadNeeds,
  withChildApprovals,
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
  });
});

describe("withChildApprovals", () => {
  it("lists the chat's subagent approvals among the project's needs, once each", () => {
    const listed = shell("listed");
    const subagent = shell("subagent");
    const needs = listProjectNeeds([listed], () => ({
      requests: { approvals: [approval("a1", "2026-11-18T10:03:00.000Z")], userInputs: [] },
      reports: [],
    }));
    const child = (thread: EnvironmentThreadShell, id: string, createdAt: string) => ({
      thread: { environmentId: thread.environmentId, threadId: thread.id },
      title: thread.title,
      approval: approval(id, createdAt),
    });
    expect(
      withChildApprovals(
        needs,
        [
          child(subagent, "a2", "2026-11-18T10:01:00.000Z"),
          // A delegated task the project lists already has its own row.
          child(listed, "a1", "2026-11-18T10:03:00.000Z"),
        ],
        [subagent, listed],
      ).map((need) => need.key),
    ).toEqual([`${local}:subagent:a2`, `${local}:listed:a1`]);
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
  });
});
