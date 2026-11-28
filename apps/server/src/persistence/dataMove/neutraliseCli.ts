// @effect-diagnostics nodeBuiltinImport:off - Standalone offline maintenance boundary.
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { neutralise } from "./neutralise.ts";
import { PreflightRefusal } from "./preflight.ts";
const isRefusal = Schema.is(PreflightRefusal);

try {
  const { positionals, values } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: { verify: { type: "boolean" }, help: { type: "boolean" } },
  });
  if (values.help)
    process.stdout.write(
      "Usage: neutraliseCli.ts <explicit-offline-copy-path> <cutover|rehearsal> [--verify]\n",
    );
  else {
    const [path, mode] = positionals;
    if (positionals.length !== 2 || !path || (mode !== "cutover" && mode !== "rehearsal"))
      throw new PreflightRefusal({ category: "explicit-path-and-mode-required" });
    const exit = await Effect.runPromiseExit(neutralise(path, mode, values.verify));
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
    process.stdout.write(JSON.stringify(exit.value, null, 2) + "\n");
    if (!exit.value.marked || Object.keys(exit.value.live).length) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      refused: isRefusal(error) ? error.category : "neutralisation-failed",
    }) + "\n",
  );
  process.exitCode = 1;
}
