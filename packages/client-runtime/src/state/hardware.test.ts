import {
  type HardwareAuditEntry,
  type HardwareDeviceConfig,
  type HardwareLeaseSummary,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  formatHardwareDuration,
  hardwareAuditDetailSummary,
  hardwareLeaseExpiryLabel,
  hardwareLeaseStateLabel,
  updateHardwareDevices,
} from "./hardware.ts";

const now = Date.parse("2026-10-18T12:00:00.000Z");
const at = (minutes: number) => DateTime.formatIso(DateTime.makeUnsafe(now + minutes * 60_000));
const lease = (overrides: Partial<HardwareLeaseSummary> = {}): HardwareLeaseSummary => ({
  threadId: ThreadId.make("thread-1"),
  purpose: "calibration capture",
  grantedAt: at(-30),
  lastActivityAt: at(-2),
  idleExpiresAt: at(12),
  hardExpiresAt: at(7 * 60 + 30),
  keepUntilReleased: false,
  ...overrides,
});

describe("formatHardwareDuration", () => {
  it("rounds down to whole units", () => {
    expect(formatHardwareDuration(30_000)).toBe("<1m");
    expect(formatHardwareDuration(12 * 60_000 + 59_000)).toBe("12m");
    expect(formatHardwareDuration(120 * 60_000)).toBe("2h");
    expect(formatHardwareDuration(125 * 60_000)).toBe("2h 5m");
    expect(formatHardwareDuration(50 * 3_600_000)).toBe("2d");
    expect(formatHardwareDuration(-5_000)).toBe("<1m");
  });
});

describe("hardware lease labels", () => {
  it("counts down the idle clock", () => {
    expect(hardwareLeaseStateLabel(lease(), now)).toBe("idle 12m left");
    expect(hardwareLeaseExpiryLabel(lease(), now)).toBe(
      "Idle, ends in 12m; ends in 7h 30m at the latest",
    );
  });

  it("reads a busy thread as working", () => {
    const working = lease({ idleExpiresAt: null });
    expect(hardwareLeaseStateLabel(working, now)).toBe("working");
    expect(hardwareLeaseExpiryLabel(working, now)).toBe(
      "Thread is working; ends in 7h 30m at the latest",
    );
  });

  it("reads a kept lease as kept, ignoring deadlines", () => {
    const kept = lease({ keepUntilReleased: true, idleExpiresAt: null, hardExpiresAt: null });
    expect(hardwareLeaseStateLabel(kept, now)).toBe("kept");
    expect(hardwareLeaseExpiryLabel(kept, now)).toBe("Kept until released");
  });

  it("does not show a negative countdown once the idle deadline passes", () => {
    expect(hardwareLeaseStateLabel(lease({ idleExpiresAt: at(-1) }), now)).toBe("idle, ending");
  });
});

describe("hardwareAuditDetailSummary", () => {
  const entry = (detail: Record<string, unknown>): HardwareAuditEntry => ({
    id: 1,
    deviceId: "tree",
    occurredAt: at(0),
    lastOccurredAt: at(0),
    actor: "thread",
    threadId: null,
    event: "call",
    action: "calibrate.led",
    detail,
    repeatCount: 1,
  });

  it("keeps the fields worth a glance and drops the rest", () => {
    expect(hardwareAuditDetailSummary(entry({ via: "tool", status: 200, durationMs: 31 }))).toBe(
      "HTTP 200",
    );
    expect(hardwareAuditDetailSummary(entry({ decision: "accept" }))).toBe("accept");
    expect(hardwareAuditDetailSummary(entry({ hook: "release", error: "unreachable" }))).toBe(
      "release hook · unreachable",
    );
    expect(hardwareAuditDetailSummary(entry({ query: { r: 1 } }))).toBeNull();
  });
});

describe("updateHardwareDevices", () => {
  const projectId = ProjectId.make("project-1");
  const accepted = { type: "led", name: "Christmas tree", actions: {} };
  const tree: HardwareDeviceConfig = {
    id: "tree",
    projectId,
    definitionFile: "tree.json",
    baseUrl: "http://tree.local",
    acceptedDefinition: accepted,
  };

  it("adds, renames and removes devices", () => {
    const added = updateHardwareDevices([], tree);
    expect(added).toEqual([tree]);
    const renamed = updateHardwareDevices(added, { ...tree, id: "tree-2" }, { originalId: "tree" });
    expect(renamed.map((device) => device.id)).toEqual(["tree-2"]);
    expect(renamed[0]?.acceptedDefinition).toEqual(accepted);
    expect(updateHardwareDevices(renamed, tree, { originalId: "tree-2", remove: true })).toEqual(
      [],
    );
  });

  it("keeps the accepted definition unless its source changes", () => {
    const { acceptedDefinition: _, ...draft } = tree;
    const moved = updateHardwareDevices([tree], { ...draft, baseUrl: "http://10.0.0.5" });
    expect(moved[0]?.acceptedDefinition).toEqual(accepted);
    const otherFile = updateHardwareDevices([tree], { ...draft, definitionFile: "lights.json" });
    expect(otherFile[0]?.acceptedDefinition).toBeUndefined();
  });
});
