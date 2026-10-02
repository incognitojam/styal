import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { summarizeHostSessions } from "./HostActivity.ts";

const thread = (id: string) => ({
  id: ThreadId.make(id),
  status: "idle" as const,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
});
describe("host session activity", () => {
  it("does not count open idle sessions as running work", () => {
    expect(summarizeHostSessions([thread("idle")])).toEqual({
      activeSessions: 0,
      continuableSessions: 0,
      waitingSessions: 0,
    });
  });
  it("deduplicates a running provider thread and its background work", () => {
    const active = {
      ...thread("active"),
      status: "running" as const,
      pendingBackgroundTasks: [{ taskId: "task", kind: "monitor" as const }],
    };
    expect(summarizeHostSessions([active])).toEqual({
      activeSessions: 1,
      continuableSessions: 0,
      waitingSessions: 0,
    });
  });
  it("counts input waits separately and protects monitoring", () => {
    expect(
      summarizeHostSessions([
        { ...thread("approval"), status: "waiting" },
        { ...thread("input"), status: "waiting" },
        { ...thread("monitor"), pendingBackgroundTasks: [{ taskId: "monitor", kind: "monitor" }] },
      ]),
    ).toEqual({ activeSessions: 1, continuableSessions: 0, waitingSessions: 2 });
  });
  it("protects dispatched turns while preparing or starting", () => {
    expect(
      summarizeHostSessions([
        { ...thread("preparing"), status: "preparing" },
        { ...thread("starting"), status: "starting" },
      ]),
    ).toEqual({ activeSessions: 2, continuableSessions: 0, waitingSessions: 0 });
  });
  it("counts continuable threads only among active threads", () => {
    expect(
      summarizeHostSessions(
        [
          { ...thread("active"), status: "running" },
          { ...thread("wait"), status: "waiting" },
        ],
        new Set(["active", "wait", "idle"]),
      ),
    ).toEqual({ activeSessions: 1, continuableSessions: 1, waitingSessions: 1 });
  });
});
