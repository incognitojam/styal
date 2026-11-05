// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

export function hasWorkerLayerExport(source: string): boolean {
  return /^export default layer;?\s*$/mu.test(source);
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const source = NodeFS.readFileSync(
    new URL("../../infra/relay/src/worker.ts", import.meta.url),
    "utf8",
  );
  if (!hasWorkerLayerExport(source)) {
    process.stderr.write(
      "infra/relay/src/worker.ts must export default layer for production deployment.\n",
    );
    process.exitCode = 1;
  }
}
