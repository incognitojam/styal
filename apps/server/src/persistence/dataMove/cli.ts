// @effect-diagnostics nodeBuiltinImport:off - Offline SQLite tooling needs synchronous Node file and descriptor operations.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { isLivePath } from "./safety.ts";
import { InventoryRefusal, isInventoryRefusal } from "./errors.ts";
import { inventory, sourcePath } from "./inventory.ts";

try {
  const { values, positionals } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: { settings: { type: "string" }, report: { type: "string" } },
  });
  if (positionals.length !== 1) throw new InventoryRefusal({ category: "source-path-required" });
  const source = sourcePath(positionals[0]!);
  const report = await inventory({
    source,
    ...(values.settings ? { settings: values.settings } : {}),
  });
  const summary = [
    `Inventory: ${report.verdict}.`,
    `Tables: ${report.tables.length}; blocking classifications: ${report.blocking}.`,
    `Event kinds: ${Object.keys(report.events).length}; JSON column kinds: ${Object.keys(report.payloads).length}.`,
    ...report.pruning.streams.map(
      (stream) =>
        `${stream.kind}: ${stream.total} snapshots; ${stream.snapshotsOnly} snapshot-only; ${stream.incomplete} incomplete retained streams; ${stream.candidateComplete} potentially complete retained streams.`,
    ),
    "No server was run. Retained-stream continuity is not proof of snapshot equivalence.",
  ].join("\n\n");
  const text = JSON.stringify({ ...report, summary }, null, 2) + "\n";
  if (values.report) {
    const requested = NodePath.resolve(values.report);
    const parent = NodeFS.realpathSync(NodePath.dirname(requested));
    const resolved = NodePath.join(parent, NodePath.basename(requested));
    if (
      parent === NodePath.dirname(source) ||
      isLivePath(requested) ||
      isLivePath(resolved) ||
      [source, source + "-wal", source + "-shm", source + "-journal"].includes(resolved)
    )
      throw new InventoryRefusal({ category: "unsafe-report-destination" });
    NodeFS.writeFileSync(resolved, text, { flag: "wx", mode: 0o600 });
  }
  process.stdout.write(text);
  process.stderr.write(summary + "\n");
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      refused: isInventoryRefusal(error) ? error.category : "inventory-failed",
    }) + "\n",
  );
  process.exitCode = 1;
}
