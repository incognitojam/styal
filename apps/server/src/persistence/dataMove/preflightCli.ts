// @effect-diagnostics nodeBuiltinImport:off - Standalone offline maintenance boundary.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import { assertOffline, preflight, PreflightRefusal } from "./preflight.ts";

const isPreflightRefusal = Schema.is(PreflightRefusal);

try {
  const { positionals, values } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: { report: { type: "string" }, help: { type: "boolean" } },
  });
  const usage =
    "Usage: preflightCli.ts <explicit-database-path> [--report <path>]\nSupported inputs: a read-only snapshot containing its WAL/SHM sidecars, or an offline copy in a writable directory. SQLite may create coordination sidecars beside a writable copy.\n";
  if (values.help) {
    process.stdout.write(usage);
    process.exit(0);
  }
  if (positionals.length !== 1)
    throw new PreflightRefusal({ category: "explicit-database-path-required" });
  const source = assertOffline(positionals[0]!);
  const result = await Effect.runPromiseExit(
    preflight(source, (line) => process.stderr.write(line + "\n")),
  );
  if (Exit.isFailure(result)) {
    const error = Cause.squash(result.cause);
    throw isPreflightRefusal(error)
      ? error
      : new PreflightRefusal({ category: "preflight-failed" });
  }
  const report = result.value;
  const rows = Object.values(report.tables).reduce((n, t) => n + t.rows, 0);
  const rejected = Object.values(report.tables).reduce((n, t) => n + t.rejected, 0);
  const sidecarChanges = report.sidecars.changed;
  const sidecarSummary = sidecarChanges.length
    ? `\nSQLite coordination sidecars created or changed: ${sidecarChanges.map((name) => "-" + name).join(", ")}.`
    : "";
  const summary = `Preflight: ${report.verdict}.\nTables: ${Object.keys(report.tables).length}; rows read: ${rows}; rows rejected: ${rejected}.\nUnexpected differences: ${report.unexpected}.${sidecarSummary}\nExecutable state requires neutralisation before startup. This report does not authorise migration or startup.`;
  const text = JSON.stringify({ ...report, summary }, null, 2) + "\n";
  if (values.report) {
    const destination = assertOffline(NodePath.resolve(values.report));
    const parent = NodePath.dirname(destination);
    if (
      parent === NodePath.dirname(source) ||
      parent.startsWith(NodePath.dirname(source) + NodePath.sep)
    )
      throw new PreflightRefusal({ category: "unsafe-report-destination" });
    NodeFS.writeFileSync(destination, text, { flag: "wx", mode: 0o600 });
  }
  process.stdout.write(text);
  process.stderr.write(summary + "\n");
  if (report.verdict !== "ready") process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      refused: isPreflightRefusal(error) ? error.category : "preflight-failed",
    }) + "\n",
  );
  process.exitCode = 1;
}
