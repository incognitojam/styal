// @effect-diagnostics nodeBuiltinImport:off - exercises the actual Node CLI entry.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import packageJson from "../package.json" with { type: "json" };
import { cli } from "./binCli.ts";
import { pairCli } from "./binPair.ts";

const capture = (command: typeof pairCli | typeof cli, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const start = (yield* TestConsole.logLines).length;
    const result = yield* Effect.result(
      Command.runWith(command, { version: packageJson.version, renderErrors: false })(args),
    );
    return { result, output: (yield* TestConsole.logLines).slice(start) };
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)));

const runEntry = (args: ReadonlyArray<string>) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url)), ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (data: string) => (stdout += data));
    child.stderr.setEncoding("utf8").on("data", (data: string) => (stderr += data));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

describe("pair CLI entry", () => {
  it.effect.each(
    [
      ["pair", "--help"],
      ["pair", "-h"],
      ["pair", "--version"],
      ["pair", "-v"],
      ["pair", "--log-level", "debug", "--help"],
      ["pair", "--log-level=warn", "--help"],
      [
        "pair",
        "--base-dir",
        "synthetic-state",
        "--ttl",
        "15m",
        "--label",
        "test-device",
        "--tailscale",
        "--tailscale-serve-port",
        "8443",
        "--help",
      ],
      ["pair", "--unknown"],
      ["pair", "--ttl", "invalid"],
      ["pair", "--tailscale-serve-port", "70000"],
      ["pair", "--log-level", "invalid"],
      ["pair", "unexpected-argument"],
    ].map((args) => ({ args })),
  )("matches the full CLI for $args", ({ args }) =>
    Effect.gen(function* () {
      const full = yield* capture(cli, args);
      const fast = yield* capture(pairCli, args);
      expect(fast).toEqual(full);
    }),
  );

  it("runs help, version, errors, and full-tree fallbacks through bin.ts", async () => {
    const help = await runEntry(["pair", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("styal pair [flags]");
    expect(help.stdout).toContain("--tailscale-serve-port");
    expect(help.stderr).toBe("");

    const version = await runEntry(["pair", "--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout).toContain(packageJson.version);

    const invalid = await runEntry(["pair", "--unknown"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stdout + invalid.stderr).toContain("--unknown");

    const prefixed = await runEntry(["--log-level", "warn", "pair", "--help"]);
    expect(prefixed.code).toBe(0);
    expect(prefixed.stdout).toBe(help.stdout);

    const auth = await runEntry(["auth", "--help"]);
    expect(auth.code).toBe(0);
    expect(auth.stdout).toContain("styal auth");

    for (const completionArgs of [["--completions", "bash"], ["--completions=bash"]]) {
      const completions = await runEntry(["pair", ...completionArgs]);
      expect(completions.code).toBe(0);
      expect(completions.stdout).toContain("pair");
      expect(completions.stdout).toContain("auth");
      expect(completions.stdout).toContain("serve");
    }
  });
});
