import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import { startedThreadState } from "./startedThreads.logic";

const shell = (overrides: Partial<EnvironmentThreadShell>) =>
  ({
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: null,
    ...overrides,
  }) as EnvironmentThreadShell;
const runtime = (status: string, extra: object = {}) =>
  ({ status, ...extra }) as EnvironmentThreadShell["runtime"];

describe("startedThreadState", () => {
  it("lists threads that work or wait on you, and drops finished, failed and archived ones", () => {
    expect(
      [
        shell({ runtime: runtime("running") }),
        shell({ runtime: runtime("running"), blockedOnThreadWait: true }),
        shell({ runtime: runtime("preparing") }),
        shell({ hasPendingApprovals: true }),
        shell({ openReportQuestionCount: 1 }),
        shell({ runtime: runtime("idle") }),
        shell({ runtime: runtime("failed") }),
        shell({ runtime: runtime("running"), archivedAt: "2026-11-18T10:00:00.000Z" }),
        null,
      ].map(startedThreadState),
    ).toEqual(["working", "working", "working", "needs-you", "needs-you", null, null, null, null]);
  });
});
