import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentId, type EnvironmentMachineKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { machineConnectionEmptyText, machineConnectionLine } from "./machineConnectionLine.logic";

const machine = (
  label: string,
  phase: EnvironmentConnectionPhase,
  flags: {
    updating?: boolean;
    awaitingSignIn?: boolean;
    kind?: EnvironmentMachineKind;
    outdated?: "client" | "server";
    hidden?: boolean;
  } = {},
) => ({
  environmentId: EnvironmentId.make(label),
  label,
  connection: { phase, error: flags.outdated ? `${label} runs another version.` : null },
  outdated: flags.outdated ?? null,
  enabled: flags.hidden !== true,
  serverConfig: flags.kind
    ? {
        environment: {
          platform: { os: "linux" as const, arch: "x64" as const, machine: flags.kind },
        },
      }
    : null,
  updating: flags.updating ?? false,
  awaitingSignIn: flags.awaitingSignIn ?? false,
});

describe("machineConnectionLine", () => {
  it.each([
    ["every machine connected", [machine("laptop", "connected")], null],
    [
      "machines switched off, an offline device and a client no update fixes",
      [machine("atlas", "available"), machine("mesa", "offline"), machine("pine", "unsupported")],
      null,
    ],
    [
      "this app is older than the machine",
      [machine("atlas", "unsupported", { outdated: "client" })],
      "Update this app to use atlas",
    ],
    [
      "the machine is older than this app",
      [machine("atlas", "unsupported", { outdated: "server" })],
      "Update styal on atlas",
    ],
    [
      "a hidden machine is neither shown nor counted",
      [
        machine("atlas", "unsupported", { outdated: "server" }),
        machine("mesa", "unsupported", { outdated: "server", hidden: true }),
      ],
      "Update styal on atlas",
    ],
    [
      "the machine updating itself",
      [machine("atlas", "unsupported", { outdated: "server", updating: true })],
      null,
    ],
    [
      "several machines older than this app",
      [
        machine("atlas", "unsupported", { outdated: "server" }),
        machine("mesa", "unsupported", { outdated: "server" }),
      ],
      "Update styal on 2 machines",
    ],
    [
      "several machines newer than this app",
      [
        machine("atlas", "unsupported", { outdated: "client" }),
        machine("mesa", "unsupported", { outdated: "client" }),
      ],
      "Update this app to use 2 machines",
    ],
    [
      "machines on both sides of this app's version",
      [
        machine("atlas", "unsupported", { outdated: "client" }),
        machine("mesa", "unsupported", { outdated: "server" }),
      ],
      "Can't use 2 machines",
    ],
    [
      "a version beside a failure and a machine still connecting",
      [
        machine("pine", "connecting"),
        machine("mesa", "error"),
        machine("atlas", "unsupported", { outdated: "server" }),
      ],
      "Can't reach or use 2 machines",
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

  it.each([
    [
      "one machine uses its own kind",
      [machine("atlas", "connecting", { kind: "laptop" })],
      "laptop",
    ],
    ["an unknown kind falls back to a server", [machine("atlas", "connecting")], "server"],
    [
      "several machines use a server",
      [machine("atlas", "connecting", { kind: "laptop" }), machine("mesa", "connecting")],
      "server",
    ],
    ["a failure keeps its warning icon", [machine("atlas", "error", { kind: "laptop" })], null],
  ])("icon: %s", (_name, environments, kind) => {
    expect(machineConnectionLine(environments)?.machineKind).toBe(kind);
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

  it("names each machine in the tooltip and retries none of the versions", () => {
    const line = machineConnectionLine([
      machine("mesa", "error"),
      machine("atlas", "unsupported", { outdated: "client" }),
    ]);
    expect(line?.tooltip).toBe("Can't reach mesa\natlas runs another version.");
    expect(line?.retryEnvironmentIds).toEqual([EnvironmentId.make("mesa")]);
    expect(
      machineConnectionLine([machine("atlas", "unsupported", { outdated: "client" })])
        ?.retryEnvironmentIds,
    ).toEqual([]);
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
