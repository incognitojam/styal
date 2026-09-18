import { EnvironmentId, ProjectId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";
import { deriveDiscordPresence } from "./discordPresence";

const now = "2026-09-18T12:00:00.000Z";
const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const options = {
  now,
  autoSettleAfterDays: 3,
  autoSettleOnMerge: true,
  serverConfigs: new Map(
    [local, remote].map((id) => [
      id,
      { environment: { capabilities: { threadSettlement: true, threadSnooze: true } } },
    ]),
  ),
  shellStatuses: new Map([local, remote].map((id) => [id, "live" as const])),
  changeRequests: new Map(),
};

function thread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId: local,
    projectId: ProjectId.make("project-a"),
    title: "Synthetic thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("Discord presence counts", () => {
  it("counts unsettled threads even when idle, deduplicates projects, and scopes projects by environment", () => {
    const result = deriveDiscordPresence({
      ...options,
      threads: [thread("a"), thread("b"), thread("c", { environmentId: remote })],
    });
    expect(result.activity).toEqual({ activeThreads: 3, activeProjects: 2 });
    expect(Object.keys(result.activity!)).toEqual(["activeThreads", "activeProjects"]);
  });

  it("excludes archived, explicitly settled, stale, snoozed, and disconnected threads", () => {
    const result = deriveDiscordPresence({
      ...options,
      shellStatuses: new Map([
        [local, "live"],
        [remote, "cached"],
      ]),
      threads: [
        thread("archived", { archivedAt: now }),
        thread("settled", { settledOverride: "settled", settledAt: now }),
        thread("stale", { latestUserMessageAt: "2026-09-01T00:00:00.000Z" }),
        thread("snoozed", { snoozedAt: now, snoozedUntil: "2026-09-18T13:00:00.000Z" }),
        thread("offline", { environmentId: remote }),
      ],
    });
    expect(result).toEqual({ activity: null, nextWakeAt: Date.parse("2026-09-18T13:00:00.000Z") });
  });

  it("counts revived, pinned, and waiting threads, and wakes snoozed threads", () => {
    const threads = [
      thread("revived", {
        settledOverride: "active",
        latestUserMessageAt: "2026-09-01T00:00:00.000Z",
      }),
      thread("pinned", { pinnedAt: now }),
      thread("approval", { settledOverride: "settled", hasPendingApprovals: true }),
      thread("input", { hasPendingUserInput: true, snoozedUntil: "2026-09-18T13:00:00.000Z" }),
      thread("woken", { snoozedUntil: now }),
    ];
    expect(deriveDiscordPresence({ ...options, threads }).activity).toEqual({
      activeThreads: 5,
      activeProjects: 1,
    });
  });

  it("applies merge settlement only for the current branch and honors the setting", () => {
    const merged = thread("merged", { branch: "feature", worktreePath: "/synthetic/workspace" });
    const key = scopedThreadKey(scopeThreadRef(local, merged.id));
    const changeRequests = new Map([
      [key, { branch: "feature", pr: { state: "merged" as const, updatedAt: now } }],
    ]);
    expect(
      deriveDiscordPresence({ ...options, threads: [merged], changeRequests }).activity,
    ).toBeNull();
    expect(
      deriveDiscordPresence({
        ...options,
        threads: [merged],
        changeRequests,
        autoSettleOnMerge: false,
      }).activity?.activeThreads,
    ).toBe(1);
    expect(
      deriveDiscordPresence({
        ...options,
        threads: [{ ...merged, branch: "other" }],
        changeRequests,
      }).activity?.activeThreads,
    ).toBe(1);
  });

  it("keeps threads active on older servers without settlement support", () => {
    expect(
      deriveDiscordPresence({
        ...options,
        serverConfigs: new Map(),
        threads: [thread("old", { latestUserMessageAt: "2026-09-01T00:00:00.000Z" })],
      }).activity?.activeThreads,
    ).toBe(1);
  });
});
