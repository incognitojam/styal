import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_HARDWARE_DEVICE_DRAFT,
  hardwareDefinitionChangeLabel,
  hardwareHealthLine,
  parseHardwareDeviceDraft,
} from "./hardwareSettings.logic";

const valid = {
  ...EMPTY_HARDWARE_DEVICE_DRAFT,
  id: "tree",
  projectId: "project-1",
  definitionFile: "tree.json",
  baseUrl: " http://tree.local/ ",
};

describe("parseHardwareDeviceDraft", () => {
  it("trims the draft into a device config", () => {
    expect(parseHardwareDeviceDraft(valid, [])).toEqual({
      ok: true,
      device: {
        id: "tree",
        projectId: "project-1",
        definitionFile: "tree.json",
        baseUrl: "http://tree.local",
      },
    });
  });

  it("keeps only the auth fields that are filled in", () => {
    const parsed = parseHardwareDeviceDraft({ ...valid, authHeader: " X-Token " }, []);
    expect(parsed.ok && parsed.device.auth).toEqual({ header: "X-Token" });
  });

  it("reports each failing field once", () => {
    const parsed = parseHardwareDeviceDraft(
      {
        ...EMPTY_HARDWARE_DEVICE_DRAFT,
        id: "Tree!",
        definitionFile: "tree.yaml",
        baseUrl: "http://user:pw@tree.local",
      },
      [],
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(Object.keys(parsed.errors).toSorted()).toEqual([
      "baseUrl",
      "definitionFile",
      "id",
      "projectId",
    ]);
    expect(parsed.errors.baseUrl).toBe(
      "Use an http(s) address without credentials, query or fragment.",
    );
  });

  it("rejects an id another device uses", () => {
    const parsed = parseHardwareDeviceDraft(valid, ["tree"]);
    expect(parsed.ok ? null : parsed.errors.id).toBe("Another device already uses this id.");
  });
});

describe("hardware labels", () => {
  it("describes definition changes", () => {
    expect(
      hardwareDefinitionChangeLabel({
        action: "calibrate.start",
        kind: "loosened",
        from: "approve",
        to: "operate",
      }),
    ).toBe("calibrate.start: looser, approve → operate");
    expect(hardwareDefinitionChangeLabel({ action: "status", kind: "added", to: "read" })).toBe(
      "status: new, read",
    );
  });

  it("describes health", () => {
    const ago = () => "5m ago";
    const base = { checkedAt: "x", lastSeenAt: null, summary: null };
    expect(hardwareHealthLine({ ...base, status: "online", summary: "idle, 42 LEDs" }, ago)).toBe(
      "idle, 42 LEDs",
    );
    expect(
      hardwareHealthLine(
        { ...base, status: "offline", lastSeenAt: "y", error: "Connection refused" },
        ago,
      ),
    ).toBe("Offline, last seen 5m ago: Connection refused");
    expect(hardwareHealthLine({ ...base, status: "unknown", checkedAt: null }, ago)).toBe(
      "Not checked yet",
    );
  });
});
