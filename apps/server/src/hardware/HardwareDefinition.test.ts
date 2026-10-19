import { describe, expect, it } from "@effect/vitest";
import type { HardwareDefinition } from "@t3tools/contracts";

import {
  actionForRequest,
  effectiveDefinition,
  parseDefinition,
  refusedQueryKeys,
  withWorktreeOverlay,
} from "./HardwareDefinition.ts";

const accepted: HardwareDefinition = {
  type: "tree",
  name: "Tree",
  health: { path: "/" },
  hooks: { release: [{ action: "calibrate.stop" }] },
  actions: {
    status: { method: "GET", path: "/", tier: "read" },
    "calibrate.stop": { method: "GET", path: "/calibrate/stop", tier: "operate" },
    reboot: { method: "POST", path: "/reboot", tier: "approve" },
  },
};

describe("effectiveDefinition", () => {
  it("uses the default branch as is when it matches what was accepted", () => {
    const effective = effectiveDefinition(accepted, accepted);
    expect(effective.pendingChanges).toEqual([]);
    expect(effective.actions.reboot?.tier).toBe("approve");
    expect(effective.hooks).toEqual(accepted.hooks);
  });

  it("holds a lowered tier at the accepted one until the user accepts it", () => {
    const main = {
      ...accepted,
      actions: {
        ...accepted.actions,
        reboot: { method: "POST", path: "/reboot", tier: "operate" },
      },
    } satisfies HardwareDefinition;
    const effective = effectiveDefinition(main, accepted);
    expect(effective.actions.reboot?.tier).toBe("approve");
    expect(effective.pendingChanges).toEqual([
      { action: "reboot", kind: "loosened", from: "approve", to: "operate" },
    ]);
  });

  it("applies a raised tier and a removed action at once", () => {
    const { reboot: _removed, ...rest } = accepted.actions;
    const main = {
      ...accepted,
      actions: { ...rest, status: { method: "GET", path: "/", tier: "operate" } },
    } satisfies HardwareDefinition;
    const effective = effectiveDefinition(main, accepted);
    expect(effective.actions.status?.tier).toBe("operate");
    expect(effective.actions.reboot).toBeUndefined();
    expect(effective.pendingChanges).toEqual([]);
  });

  it("runs new and reshaped actions at approve", () => {
    const main = {
      ...accepted,
      actions: {
        ...accepted.actions,
        "calibrate.stop": { method: "GET", path: "/calibrate/off", tier: "operate" },
        "maintenance.start": { method: "POST", path: "/maintenance/start", tier: "operate" },
      },
    } satisfies HardwareDefinition;
    const effective = effectiveDefinition(main, accepted);
    expect(effective.actions["calibrate.stop"]?.tier).toBe("approve");
    expect(effective.actions["maintenance.start"]?.tier).toBe("approve");
    expect(effective.pendingChanges.map((change) => change.kind)).toEqual(["other", "added"]);
  });

  it("keeps running the accepted hooks while changed hooks wait", () => {
    const main = {
      ...accepted,
      hooks: { release: [{ action: "reboot" }] },
    } satisfies HardwareDefinition;
    const effective = effectiveDefinition(main, accepted);
    expect(effective.hooks).toEqual(accepted.hooks);
    expect(effective.hookActions["calibrate.stop"]?.path).toBe("/calibrate/stop");
    expect(effective.pendingChanges).toEqual([{ action: "hooks", kind: "hooks-changed" }]);
  });

  it("treats a definition nobody accepted as entirely pending", () => {
    const effective = effectiveDefinition(accepted, undefined);
    expect(Object.values(effective.actions).every((action) => action.tier === "approve")).toBe(
      true,
    );
    expect(effective.hooks).toEqual({});
    expect(effective.health).toBeUndefined();
  });
});

describe("withWorktreeOverlay", () => {
  it("lets a branch add endpoints only at approve and never loosen", () => {
    const actions = withWorktreeOverlay(accepted.actions, {
      ...accepted,
      actions: {
        status: { method: "GET", path: "/", tier: "read" },
        reboot: { method: "POST", path: "/reboot", tier: "read" },
        "maintenance.start": { method: "POST", path: "/maintenance/start", tier: "read" },
      },
    });
    expect(actions.status?.tier).toBe("read");
    expect(actions.reboot?.tier).toBe("approve");
    expect(actions["maintenance.start"]?.tier).toBe("approve");
    expect(actions["calibrate.stop"]?.tier).toBe("operate");
  });
});

describe("request matching", () => {
  it("maps a method and path to its action", () => {
    expect(actionForRequest(accepted.actions, "GET", "/calibrate/stop")?.name).toBe(
      "calibrate.stop",
    );
    expect(actionForRequest(accepted.actions, "POST", "/calibrate/stop")).toBeUndefined();
  });

  it("names query keys an action does not allow", () => {
    expect(
      refusedQueryKeys({ method: "GET", path: "/led", tier: "operate", query: ["n"] }, [
        "n",
        "all",
      ]),
    ).toEqual(["all"]);
  });
});

describe("parseDefinition", () => {
  it("rejects a definition with an invalid tier", () => {
    const result = parseDefinition(
      JSON.stringify({
        type: "tree",
        name: "Tree",
        actions: { status: { method: "GET", path: "/", tier: "sometimes" } },
      }),
    );
    expect("error" in result).toBe(true);
  });

  it("reads a valid definition", () => {
    const result = parseDefinition(JSON.stringify(accepted));
    expect("definition" in result && result.definition.name).toBe("Tree");
  });
});

describe("action paths", () => {
  it.each(["//other-host/steal", "/\\\\other-host/steal", "/led?n=1"])(
    "rejects %s, which could leave the device",
    (path) => {
      const result = parseDefinition(
        JSON.stringify({
          type: "tree",
          name: "Tree",
          actions: { led: { method: "GET", path, tier: "operate" } },
        }),
      );
      expect("error" in result).toBe(true);
    },
  );
});
