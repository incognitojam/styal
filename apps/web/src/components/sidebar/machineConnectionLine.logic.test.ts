import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { machineConnectionEmptyText, machineConnectionLine } from "./machineConnectionLine.logic";

const machine = (
  label: string,
  phase: EnvironmentConnectionPhase,
  flags: { updating?: boolean; awaitingSignIn?: boolean } = {},
) => ({
  environmentId: EnvironmentId.make(label),
  label,
  connection: { phase },
  updating: flags.updating ?? false,
  awaitingSignIn: flags.awaitingSignIn ?? false,
});

describe("machineConnectionLine", () => {
  it.each([
    ["every machine connected", [machine("laptop", "connected")], null],
    [
      "machines switched off, an offline device and an incompatible version",
      [machine("atlas", "available"), machine("mesa", "offline"), machine("pine", "unsupported")],
      null,
    ],
    ["one machine connecting", [machine("atlas", "connecting")], "Connecting to atlas"],
    [
      "two machines connecting",
      [machine("atlas", "connecting"), machine("mesa", "connecting")],
      "Connecting to atlas and mesa",
    ],
    [
      "three machines connecting",
      [
        machine("atlas", "connecting"),
        machine("mesa", "connecting"),
        machine("pine", "connecting"),
      ],
      "Connecting to 3 machines",
    ],
    ["a failed attempt retrying", [machine("atlas", "reconnecting")], "Can't reach atlas"],
    [
      "a server update restarting the machine",
      [machine("atlas", "reconnecting", { updating: true })],
      null,
    ],
    [
      "retries stopped during a server update",
      [machine("atlas", "error", { updating: true })],
      "Can't reach atlas",
    ],
    [
      "a styal Link machine with no sign-in",
      [machine("atlas", "error", { awaitingSignIn: true })],
      null,
    ],
    [
      "a failure beside a machine still connecting",
      [machine("mesa", "connecting"), machine("atlas", "error")],
      "Can't reach atlas",
    ],
  ])("%s", (_name, environments, text) => {
    expect(machineConnectionLine(environments)?.text ?? null).toBe(text);
  });

  it("retries only the failed machines and keeps the first waiting machine across tones", () => {
    const line = machineConnectionLine([
      machine("laptop", "connected"),
      machine("mesa", "connecting"),
      machine("atlas", "error"),
    ]);
    expect(line?.retryEnvironmentIds).toEqual([EnvironmentId.make("atlas")]);
    expect(line?.waitingEnvironmentId).toBe(EnvironmentId.make("mesa"));
  });
});

describe("machineConnectionEmptyText", () => {
  it.each([
    [[machine("laptop", "connected")], null],
    [[machine("atlas", "connecting")], "Projects on atlas show up here once it connects"],
    [
      [machine("mesa", "connecting"), machine("atlas", "reconnecting")],
      "Projects on atlas and mesa show up here once they connect",
    ],
    [
      [machine("atlas", "connecting", { awaitingSignIn: true, updating: true })],
      "Projects on atlas show up here once it connects",
    ],
  ])("%j", (environments, text) => {
    expect(machineConnectionEmptyText(environments)).toBe(text);
  });
});
