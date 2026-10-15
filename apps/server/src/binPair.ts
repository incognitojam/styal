import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import packageJson from "../package.json" with { type: "json" };
import { pairCommand } from "./cli/pair.ts";

export const pairCli = Command.make("styal").pipe(
  Command.withDescription("Run and manage styal."),
  Command.withSubcommands([pairCommand]),
);

export async function runPairCli() {
  // Completion scripts describe every command, so they need the full CLI tree.
  if (process.argv.some((arg) => arg === "--completions" || arg.startsWith("--completions="))) {
    const { runCli } = await import("./binCli.ts");
    runCli();
    return;
  }

  Command.run(pairCli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
    NodeRuntime.runMain,
  );
}
