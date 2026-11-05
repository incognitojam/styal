import { assert, it } from "@effect/vitest";
import { hasWorkerLayerExport } from "./check-worker-export.ts";

it("requires the relay deployment layer, including when the module still has named exports", () => {
  assert.isTrue(hasWorkerLayerExport("const layer = {};\nexport default layer;\n"));
  assert.isFalse(hasWorkerLayerExport("export const layer = {};\n"));
  assert.isFalse(hasWorkerLayerExport("const layer = {};\n// export default layer;\n"));
});
