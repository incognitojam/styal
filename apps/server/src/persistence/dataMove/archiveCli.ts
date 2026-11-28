// @effect-diagnostics nodeBuiltinImport:off - Standalone offline maintenance boundary.
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { archive } from "./archive.ts";
import { PreflightRefusal } from "./preflight.ts";

const isRefusal = Schema.is(PreflightRefusal);
try {
  const { positionals, values } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      verify: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(
      "Usage: archiveCli.ts <explicit-offline-copy-path> [--verify]\nVerify checks archive integrity separately from source equality and selected-cell coverage.\nRun archive once on a fresh copy. A changed selection requires starting again from a fresh copy; existing archives are never topped up.\n",
    );
  } else {
    if (positionals.length !== 1)
      throw new PreflightRefusal({ category: "explicit-database-path-required" });
    const exit = await Effect.runPromiseExit(archive(positionals[0]!, values.verify));
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
    process.stdout.write(JSON.stringify(exit.value, null, 2) + "\n");
    if (exit.value.missingSelectedCells !== null && exit.value.missingSelectedCells > 0)
      process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(
    JSON.stringify({ refused: isRefusal(error) ? error.category : "archive-failed" }) + "\n",
  );
  process.exitCode = 1;
}
