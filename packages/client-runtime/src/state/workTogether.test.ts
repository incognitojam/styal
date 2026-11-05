import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import {
  planStopWorkingTogether,
  planWorkTogether,
  runWorkTogetherLines,
  workTogetherFailureMessage,
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
  { environmentId, status: "reachable" as const },
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
      atlas({ allowsLinks: true, links: [{ environmentId: orionId, status: "expired" }] }),
      orion({ allowsLinks: true, links: linkedTo(atlasId) }),
    );
    expect(states(lines)["link:atlas"]).toBe("pending");
  });

  it("shares from whichever machine has devices, to a machine that can use them", () => {
    const shares = (a: WorkTogetherMachine, b: WorkTogetherMachine) =>
      planWorkTogether(a, b).flatMap(({ step }) =>
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

describe("runWorkTogetherLines", () => {
  it.effect("does everything on two connected machines", () =>
    Effect.gen(function* () {
      const { ran, lines } = yield* run(planWorkTogether(atlas({ hasDevices: true }), orion()));
      expect(ran).toEqual(["allow", "allow", "link", "link", "share"]);
      expect(workTogetherOutcome(lines)).toBe("complete");
    }),
  );

  it.effect("does what it can on the machine that is awake, and waits for the other", () =>
    Effect.gen(function* () {
      const asleep = orion({ connected: false, links: null });
      const { ran, lines } = yield* run(planWorkTogether(atlas({ hasDevices: true }), asleep));
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
      const { ran, lines } = yield* run(planWorkTogether(atlas({ hasDevices: true }), orion()), [
        "allow",
      ]);
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
      const first = yield* run(planWorkTogether(atlas(), orion()), ["link"]);
      expect(first.ran).toEqual(["allow", "allow", "link", "link"]);
      const retried = planWorkTogether(
        atlas({ allowsLinks: true }),
        orion({ allowsLinks: true, links: linkedTo(atlasId) }),
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
