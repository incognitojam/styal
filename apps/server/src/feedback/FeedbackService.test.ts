import { RunId, NodeId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { SourceControlDrivers } from "../sourceControl/builtInDrivers.ts";
import * as FeedbackService from "./FeedbackService.ts";
import { classifyReport } from "../../../../scripts/issue-routing.ts";

const threadId = ThreadId.make("thread-1");
const draft = { title: "The sidebar is empty", body: "Open the app and the sidebar is empty." };

function manualFormBody(body: string) {
  const actual = new URL(FeedbackService.manualIssueUrl(draft.title, body)).searchParams.get(
    "actual",
  );
  return `### Before submitting

- [x] I searched existing issues and did not find a duplicate.
- [x] I included enough detail to reproduce or investigate the problem.

### Area

apps/web

### Steps to reproduce

Open the app.

### Expected behavior

The sidebar lists threads.

### Actual behavior

${actual}

### Impact

Major degradation or frequent failure

### Version or commit

_No response_

### Environment

_No response_

### Logs or stack traces

_No response_

### Screenshots, recordings, or supporting files

_No response_

### Workaround

_No response_`;
}

/** A thread with a running turn whose approval card the "user" answers as soon as it opens. */
function harness(input: {
  readonly account?: string | null;
  readonly decision?: "accept" | "decline";
  readonly filing?: { readonly status: "refused"; readonly reason: string };
  readonly activeRun?: boolean;
  readonly instanceId?: string;
}) {
  const filed: Array<Record<string, string>> = [];
  const approvals: Array<{
    approvalStatus: string;
    attention?: string;
    prompt: string;
    requestId: string;
    toolInput: unknown;
  }> = [];
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadRecords: () =>
      Effect.succeed({
        thread: {
          modelSelection: {
            instanceId: input.instanceId ?? "claudeAgent",
            model: "claude-opus-5-5",
          },
        },
        runs:
          input.activeRun === false
            ? []
            : [
                {
                  id: RunId.make("run-1"),
                  rootNodeId: NodeId.make("node-1"),
                  status: "running",
                  ordinal: 1,
                },
              ],
        runtimeRequests: approvals.slice(0, 1).map(({ requestId }) => ({
          id: requestId,
          status: "resolved",
          decision: input.decision ?? "accept",
        })),
      }) as never,
    dispatch: ((command: (typeof approvals)[number]) =>
      Effect.sync(() => {
        approvals.push(command);
        return {} as never;
      })) as never,
  });
  const drivers = Layer.succeed(SourceControlDrivers, [
    {
      driver: { kind: "github" },
      instance: {
        issueFiling: {
          account: () => Effect.succeed(input.account === undefined ? "octocat" : input.account),
          file: (request: Record<string, string>) =>
            Effect.sync(() => {
              filed.push(request);
              return input.filing ?? { status: "filed", url: "https://github.com/issue/1" };
            }),
        },
      },
    },
  ] as never);
  return {
    filed,
    approvals,
    layer: FeedbackService.layer.pipe(Layer.provide(Layer.merge(threads, drivers))),
  };
}

describe("reportFromAgent", () => {
  it.effect("files the approved text on styal's own repository", () => {
    const { filed, approvals, layer } = harness({});
    return Effect.gen(function* () {
      const feedback = yield* FeedbackService.FeedbackService;
      expect(yield* feedback.reportFromAgent(threadId, draft)).toEqual({
        status: "filed",
        issueUrl: "https://github.com/issue/1",
      });
      expect(filed).toHaveLength(1);
      expect(filed[0]).toMatchObject({ host: "github.com", repository: "incognitojam/styal" });
      expect(filed[0]?.body).toContain(draft.body);
      expect(filed[0]?.body).toContain("Written by an agent (Claude, claude-opus-5-5)");
      expect(classifyReport(filed[0]?.body)).toBe("agent");
      expect(classifyReport(manualFormBody(filed[0]?.body ?? ""))).toBe("agent");
      // The card shows the text that gets posted, under the account that posts it.
      expect(approvals[0]?.attention).toBe("input");
      expect(approvals[0]?.prompt).toContain("as @octocat");
      expect(approvals[0]?.prompt).toContain(filed[0]?.body);
      expect(approvals[0]?.prompt).toContain(draft.title);
      expect(approvals[0]?.toolInput).toEqual({
        title: draft.title,
        body: filed[0]?.body,
        repository: "incognitojam/styal",
        account: "octocat",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves a custom provider instance's name out of the footer", () => {
    const { filed, layer } = harness({ instanceId: "acme_work_claude" });
    return Effect.gen(function* () {
      const feedback = yield* FeedbackService.FeedbackService;
      yield* feedback.reportFromAgent(threadId, draft);
      expect(filed[0]?.body).toContain("Written by an agent (claude-opus-5-5)");
      expect(filed[0]?.body).not.toContain("acme_work_claude");
    }).pipe(Effect.provide(layer));
  });

  it.effect("posts nothing when the user declines", () => {
    const { filed, layer } = harness({ decision: "decline" });
    return Effect.gen(function* () {
      const feedback = yield* FeedbackService.FeedbackService;
      expect(yield* feedback.reportFromAgent(threadId, draft)).toEqual({ status: "declined" });
      expect(filed).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips the card and offers a link when the server has no GitHub sign-in", () => {
    const { filed, approvals, layer } = harness({ account: null });
    return Effect.gen(function* () {
      const feedback = yield* FeedbackService.FeedbackService;
      const result = yield* feedback.reportFromAgent(threadId, draft);
      expect(result).toMatchObject({ status: "not_filed" });
      expect(result.status === "not_filed" && result.manualUrl).toContain(
        "template=bug_report.yml",
      );
      expect(approvals).toEqual([]);
      expect(filed).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("offers a link when GitHub refuses the approved report", () => {
    const { layer } = harness({ filing: { status: "refused", reason: "Resource not accessible" } });
    return Effect.gen(function* () {
      const feedback = yield* FeedbackService.FeedbackService;
      expect(yield* feedback.reportFromAgent(threadId, draft)).toMatchObject({
        status: "not_filed",
        reason: "Resource not accessible",
      });
    }).pipe(Effect.provide(layer));
  });
});

describe("submit", () => {
  it.effect("files what the user wrote with diagnostics and no approval card", () => {
    const { filed, approvals, layer } = harness({});
    return Effect.gen(function* () {
      const feedback = yield* FeedbackService.FeedbackService;
      expect(yield* feedback.submit(draft)).toMatchObject({ status: "filed" });
      expect(approvals).toEqual([]);
      expect(filed[0]?.body).toContain(draft.body);
      expect(filed[0]?.body).toContain("Sent from styal by the user.");
      expect(classifyReport(filed[0]?.body)).toBe("user");
      expect(classifyReport(manualFormBody(filed[0]?.body ?? ""))).toBe("user");
      expect(filed[0]?.body).toMatch(/styal \S+ \(\S+\), \S+ \S+/);
    }).pipe(Effect.provide(layer));
  });
});

describe("manualIssueUrl", () => {
  it("fills the bug form by field id and keeps the link short", () => {
    const url = new URL(FeedbackService.manualIssueUrl("A title", "x".repeat(10_000)));
    expect(url.pathname).toBe("/incognitojam/styal/issues/new");
    expect(url.searchParams.get("template")).toBe("bug_report.yml");
    expect(url.searchParams.get("title")).toBe("A title");
    expect(url.searchParams.get("actual")).toContain("(shortened to fit in a link)");
    expect(url.href.length).toBeLessThan(4_000);
    for (const author of [
      "Sent from styal by the user.",
      "Written by an agent and approved by the user.",
      "Written by an agent (Codex, model) and approved by the user.",
    ]) {
      const suffix = `\n\n---\nstyal 0.1.1 (nightly), linux x64\n${author}`;
      const actual = new URL(
        FeedbackService.manualIssueUrl("A title", "x".repeat(2_500) + suffix),
      ).searchParams.get("actual");
      expect(actual?.endsWith(suffix)).toBe(true);
      expect(actual).toContain("(shortened to fit in a link)");
      expect(actual?.length).toBeLessThanOrEqual(2_500);
    }
    const oversized = `\n\n---\nstyal 0.1.1 (nightly), linux x64\nWritten by an agent (Codex, ${"x".repeat(3_000)}) and approved by the user.`;
    const capped = new URL(
      FeedbackService.manualIssueUrl("A title", "A report" + oversized),
    ).searchParams.get("actual");
    expect(capped).toBe(
      "A report\n\n---\nstyal 0.1.1 (nightly), linux x64\nWritten by an agent and approved by the user.",
    );
    expect(capped?.length).toBeLessThanOrEqual(2_500);
  });
});
