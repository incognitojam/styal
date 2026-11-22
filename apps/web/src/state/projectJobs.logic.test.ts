import { describe, expect, it } from "vite-plus/test";
import { ScheduledTaskId, ThreadId, type ScheduledTaskThreadListResult } from "@t3tools/contracts";

import { clearProjectJobs, rememberProjectJobs } from "./projectJobs.logic";
import { jobThreadStates } from "../components/project/projectPage.logic";

describe("rememberProjectJobs", () => {
  it("keeps known jobs while a reload is unknown, then replaces them with the live answer", () => {
    const data = new Map<string, string>();
    const storage = () => ({
      removeItem: (key: string) => {
        data.delete(key);
      },
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    });
    const jobs: ScheduledTaskThreadListResult = {
      tasks: [
        {
          id: ScheduledTaskId.make("job:triage"),
          title: "Triage issues",
          enabled: true,
          schedule: { type: "webhook", signature: null, maxDeliveryAgeMinutes: null },
          threadId: ThreadId.make("thread:triage"),
          createdAt: "2026-11-01T00:00:00Z",
          nextRunAt: null,
          lastRunAt: "2026-11-20T12:00:00Z",
          lastRunStatus: "succeeded",
        },
      ],
    };
    expect(rememberProjectJobs("workshop", null, storage)).toBeNull();
    rememberProjectJobs("workshop", jobs, storage);
    const restored = rememberProjectJobs("workshop", null, storage);
    expect(jobThreadStates(restored?.tasks ?? []).has(ThreadId.make("thread:triage"))).toBe(true);
    expect(rememberProjectJobs("other", null, storage)).toBeNull();
    rememberProjectJobs("workshop", { tasks: [] }, storage);
    expect(rememberProjectJobs("workshop", null, storage)).toEqual({ tasks: [] });
    rememberProjectJobs("workshop", jobs, storage);
    clearProjectJobs("workshop", storage);
    expect(rememberProjectJobs("workshop", null, storage)).toBeNull();
    data.set("styal:project-jobs:workshop", "broken");
    expect(rememberProjectJobs("workshop", null, storage)).toBeNull();
    expect(
      rememberProjectJobs("workshop", jobs, () => {
        throw new Error("storage blocked");
      }),
    ).toBe(jobs);
  });
});
