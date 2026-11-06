import { type AuthMcpClientAccess, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import {
  planStopWorkingTogether,
  planWorkTogether,
  runWorkTogetherLines,
  workTogetherDefaultAccess,
  workTogetherLabels,
  workTogetherFailureMessage,
  workTogetherMissingShares,
  workTogetherOutcome,
  type WorkTogetherLine,
  type WorkTogetherMachine,
  workTogetherStatus,
} from "./workTogether.ts";

const atlasId = EnvironmentId.make("atlas");
const orionId = EnvironmentId.make("orion");

const machine = (
  environmentId: EnvironmentId,
  label: string,
  overrides: Partial<WorkTogetherMachine> = {},
): WorkTogetherMachine => ({
  environmentId,
  label,
  ownLabel: label,
  connected: true,
  loaded: true,
  canManage: true,
  allowsLinks: false,
  links: [],
  urls: [`https://${label}.example`],
  deviceUrls: [`https://${label}.example`],
  hasDevices: false,
  usesSharedDevices: true,
  sharedDeviceHosts: [],
  ...overrides,
});
const atlas = (overrides: Partial<WorkTogetherMachine> = {}) =>
  machine(atlasId, "Atlas", overrides);
const orion = (overrides: Partial<WorkTogetherMachine> = {}) =>
  machine(orionId, "Orion", overrides);
const linkedTo = (environmentId: EnvironmentId) => [
  { environmentId, status: "reachable" as const, access: "full-access" as const },
];

const run = Effect.fnUntraced(function* (
  lines: ReadonlyArray<WorkTogetherLine>,
  failing: ReadonlyArray<string> = [],
) {
  const ran: Array<string> = [];
  const finished = yield* runWorkTogetherLines(
    lines,
    (step) => {
      ran.push(step.kind);
      return failing.includes(step.kind)
        ? Effect.fail({ _tag: "PeerLinkError", message: `${step.kind} refused` })
        : Effect.void;
    },
    () => {},
  );
  return { ran, lines: finished };
});
const states = (lines: ReadonlyArray<WorkTogetherLine>) =>
  Object.fromEntries(lines.map(({ id, status }) => [id, status.state]));

describe("planWorkTogether", () => {
  it.effect("starts what is already true as done, so a rerun only finishes", () =>
    Effect.gen(function* () {
      const lines = planWorkTogether(
        atlas({ allowsLinks: true, links: linkedTo(orionId) }),
        orion(),
        "full-access",
      );
      expect(states(lines)).toEqual({
        "allow:atlas": "done",
        "allow:orion": "pending",
        "link:atlas": "done",
        "link:orion": "pending",
      });
      expect((yield* run(lines)).ran).toEqual(["allow", "link"]);
    }),
  );

  it("links again when a link has expired", () => {
    const lines = planWorkTogether(
      atlas({
        allowsLinks: true,
        links: [{ environmentId: orionId, status: "expired", access: "full-access" }],
      }),
      orion({ allowsLinks: true, links: linkedTo(atlasId) }),
      "full-access",
    );
    expect(states(lines)["link:atlas"]).toBe("pending");
  });

  it("shares from whichever machine has devices, to a machine that can use them", () => {
    const shares = (a: WorkTogetherMachine, b: WorkTogetherMachine) =>
      planWorkTogether(a, b, "full-access").flatMap(({ step }) =>
        step.kind === "share" ? [`${step.device.label}>${step.agent.label}`] : [],
      );
    expect(shares(atlas({ hasDevices: true }), orion())).toEqual(["Atlas>Orion"]);
    expect(shares(atlas({ hasDevices: true }), orion({ hasDevices: true }))).toEqual([
      "Atlas>Orion",
      "Orion>Atlas",
    ]);
    expect(shares(atlas(), orion())).toEqual([]);
    expect(shares(atlas({ hasDevices: true }), orion({ usesSharedDevices: false }))).toEqual([]);
  });
});

describe("access", () => {
  const linked = (access: AuthMcpClientAccess) => [
    { environmentId: orionId, status: "reachable" as const, access },
  ];

  it("replaces a link at other access than the one chosen, either way", () => {
    const state = (existing: AuthMcpClientAccess, chosen: AuthMcpClientAccess) =>
      states(
        planWorkTogether(atlas({ allowsLinks: true, links: linked(existing) }), orion(), chosen),
      )["link:atlas"];
    expect(state("full-access", "read-only")).toBe("pending");
    expect(state("read-only", "full-access")).toBe("pending");
    expect(state("auto", "auto")).toBe("done");
  });

  it("opens the picker on the narrowest access already given", () => {
    expect(workTogetherDefaultAccess(atlas(), orion())).toBe("full-access");
    expect(
      workTogetherDefaultAccess(
        atlas({ links: linked("read-only") }),
        orion({
          links: [{ environmentId: atlasId, status: "reachable", access: "full-access" }],
        }),
      ),
    ).toBe("read-only");
  });
});

describe("workTogetherMissingShares", () => {
  it("names a share that failed, and only one that could exist", () => {
    const names = (a: WorkTogetherMachine, b: WorkTogetherMachine) =>
      workTogetherMissingShares(a, b).map(({ device }) => device.label);
    expect(names(atlas({ hasDevices: true }), orion())).toEqual(["Atlas"]);
    expect(names(atlas(), orion())).toEqual([]);
    expect(
      names(
        atlas({ hasDevices: true }),
        orion({
          sharedDeviceHosts: [{ id: "environment:atlas" as never, environmentId: atlasId }],
        }),
      ),
    ).toEqual([]);
  });
});

describe("runWorkTogetherLines", () => {
  it.effect("does everything on two connected machines", () =>
    Effect.gen(function* () {
      const { ran, lines } = yield* run(
        planWorkTogether(atlas({ hasDevices: true }), orion(), "full-access"),
      );
      expect(ran).toEqual(["allow", "allow", "link", "link", "share"]);
      expect(workTogetherOutcome(lines)).toBe("complete");
    }),
  );

  it.effect("does what it can on the machine that is awake, and waits for the other", () =>
    Effect.gen(function* () {
      const asleep = orion({ connected: false, links: null });
      const { ran, lines } = yield* run(
        planWorkTogether(atlas({ hasDevices: true }), asleep, "full-access"),
      );
      expect(ran).toEqual(["allow"]);
      expect(states(lines)).toEqual({
        "allow:atlas": "done",
        "allow:orion": "waiting",
        "link:atlas": "waiting",
        "link:orion": "waiting",
        "share:atlas": "waiting",
      });
      expect(workTogetherOutcome(lines)).toBe("waiting");
    }),
  );

  it.effect("keeps going past a failure, and does not run what needed it", () =>
    Effect.gen(function* () {
      const { ran, lines } = yield* run(
        planWorkTogether(atlas({ hasDevices: true }), orion(), "full-access"),
        ["allow"],
      );
      expect(ran).toEqual(["allow", "allow", "share"]);
      expect(states(lines)).toEqual({
        "allow:atlas": "failed",
        "allow:orion": "failed",
        "link:atlas": "blocked",
        "link:orion": "blocked",
        "share:atlas": "done",
      });
      expect(lines[0]?.status).toEqual({ state: "failed", message: "allow refused" });
      expect(workTogetherOutcome(lines)).toBe("failed");
    }),
  );

  it.effect("a second run after a partial failure only does what is left", () =>
    Effect.gen(function* () {
      const first = yield* run(planWorkTogether(atlas(), orion(), "full-access"), ["link"]);
      expect(first.ran).toEqual(["allow", "allow", "link", "link"]);
      const retried = planWorkTogether(
        atlas({ allowsLinks: true }),
        orion({ allowsLinks: true, links: linkedTo(atlasId) }),
        "full-access",
      );
      expect((yield* run(retried)).ran).toEqual(["link"]);
    }),
  );
});

describe("planStopWorkingTogether", () => {
  const together = {
    a: atlas({
      allowsLinks: true,
      links: linkedTo(orionId),
      hasDevices: true,
    }),
    b: orion({
      allowsLinks: true,
      links: linkedTo(atlasId),
      sharedDeviceHosts: [
        // The host id's own format belongs to the server.
        { id: "environment:atlas" as never, environmentId: atlasId },
      ],
    }),
  };

  it.effect("stops sharing, removes both links and ends both sessions", () =>
    Effect.gen(function* () {
      const { ran, lines } = yield* run(planStopWorkingTogether(together.a, together.b));
      expect(ran).toEqual(["unshare", "unlink", "unlink", "revoke", "revoke"]);
      expect(workTogetherOutcome(lines)).toBe("complete");
    }),
  );

  it.effect(
    "removes this side while the other machine is asleep, and leaves the rest waiting",
    () =>
      Effect.gen(function* () {
        const { ran, lines } = yield* run(
          planStopWorkingTogether(together.a, { ...together.b, connected: false }),
        );
        // Orion holds the device share and its own link; Atlas can end Orion's session itself.
        expect(ran).toEqual(["unlink", "revoke"]);
        expect(states(lines)).toEqual({
          "unshare:atlas": "waiting",
          "unlink:atlas": "done",
          "unlink:orion": "waiting",
          "revoke:orion": "waiting",
          "revoke:atlas": "done",
        });
      }),
  );
});

describe("workTogetherStatus", () => {
  it.each([
    ["separate", atlas(), orion()],
    [
      "together",
      atlas({ allowsLinks: true, links: linkedTo(orionId) }),
      orion({ allowsLinks: true, links: linkedTo(atlasId) }),
    ],
    [
      "partial",
      atlas({ allowsLinks: true, links: linkedTo(orionId) }),
      orion({ allowsLinks: true }),
    ],
    [
      "partial",
      atlas({ allowsLinks: false, links: linkedTo(orionId) }),
      orion({ allowsLinks: true, links: linkedTo(atlasId) }),
    ],
    [
      "together",
      atlas({ allowsLinks: true, links: linkedTo(orionId) }),
      orion({ connected: false, links: null }),
    ],
    ["partial", atlas({ connected: false, links: null }), orion({ connected: false, links: null })],
  ] as const)("%s", (expected, a, b) => {
    expect(workTogetherStatus(a, b)).toBe(expected);
  });
});

describe("workTogetherFailureMessage", () => {
  it("passes on messages written for people and hides everything else", () => {
    expect(workTogetherFailureMessage({ _tag: "PeerLinkError", message: "Refused." })).toBe(
      "Refused.",
    );
    expect(
      workTogetherFailureMessage({ _tag: "DeviceHostUnavailableError", reason: "Gone." }),
    ).toBe("Gone.");
    expect(
      workTogetherFailureMessage({ _tag: "RpcClientError", message: "pairingCode=ABC123" }),
    ).toBe("This step did not finish. Try again.");
  });
});

it("identifies duplicate names across every pair without changing unique names", () => {
  const machines = [atlas(), machine(EnvironmentId.make("atlas-two"), "Atlas"), orion()];
  expect(workTogetherLabels(machines).map(({ label }) => label)).toEqual([
    "Atlas (atlas)",
    "Atlas (atlas-two)",
    "Orion",
  ]);
  expect(machines[0]?.label).toBe("Atlas");
});
