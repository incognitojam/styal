import { assert, describe, it } from "@effect/vitest";

import {
  namespaceAlias,
  parseReferenceErrors,
  relativeSpecifier,
  renameIdentifier,
  useNamespaceImport,
} from "./references.ts";
import { applyIdentifierRenames, deriveIdentifierRenames } from "./renames.ts";

describe("deriveIdentifierRenames", () => {
  it("reads renames from paired lines and drops names renamed two ways", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "@@ -1,2 +1,2 @@",
      "-const socketLayer = make(1);",
      "-yield* use(socketLayer, httpLayer);",
      "+const layerSocket = make(1);",
      "+yield* use(layerSocket, layerHttp);",
      "@@ -9 +9 @@",
      "-const value = 1;",
      "+const value = 2;",
      "@@ -12 +12 @@",
      "-httpLayer;",
      "+layerHttpClient;",
    ].join("\n");
    assert.deepStrictEqual([...deriveIdentifierRenames(patch)], [["socketLayer", "layerSocket"]]);
  });

  it("applies renames to whole identifiers only", () => {
    assert.strictEqual(
      applyIdentifierRenames(
        "socketLayer(socketLayers)",
        new Map([["socketLayer", "layerSocket"]]),
      ),
      "layerSocket(socketLayers)",
    );
  });
});

describe("parseReferenceErrors", () => {
  it("reads names, exports, namespace members, and modules relative to the repository", () => {
    const output = [
      "src/a.ts(3,5): error TS2304: Cannot find name 'makeLayer'.",
      `src/b.ts(1,10): error TS2305: Module '"../persistence/Layers/Sqlite.ts"' has no exported member 'SqlitePersistenceMemory'.`,
      `src/c.ts(4,1): error TS2339: Property 'DeviceToolkitRegistrationLive' does not exist on type 'typeof import("/repo/apps/server/src/mcp/McpHttpServer")'.`,
      "src/d.ts(2,3): error TS2307: Cannot find module '../persistence/Layers/Sqlite.ts' or its corresponding type declarations.",
      "src/e.ts(9,9): error TS2345: Argument of type 'string' is not assignable.",
    ].join("\n");
    assert.deepStrictEqual(parseReferenceErrors(output, "apps/server"), [
      { kind: "name", file: "apps/server/src/a.ts", name: "makeLayer" },
      {
        kind: "export",
        file: "apps/server/src/b.ts",
        module: "../persistence/Layers/Sqlite.ts",
        name: "SqlitePersistenceMemory",
      },
      { kind: "member", file: "apps/server/src/c.ts", name: "DeviceToolkitRegistrationLive" },
      { kind: "module", file: "apps/server/src/d.ts", module: "../persistence/Layers/Sqlite.ts" },
    ]);
  });
});

describe("renameIdentifier", () => {
  it("renames uses and namespace members but not longer names", () => {
    assert.strictEqual(
      renameIdentifier(
        "A.runtimeLayer(runtimeLayer, runtimeLayerX)",
        "runtimeLayer",
        "layerRuntime",
      ),
      "A.layerRuntime(layerRuntime, runtimeLayerX)",
    );
  });
});

describe("useNamespaceImport", () => {
  it("imports a module by namespace when its export became a bare layer", () => {
    const text = [
      'import { other, orchestrationHttpApiLayer } from "./http.ts";',
      "const routes = build().pipe(Layer.provide(orchestrationHttpApiLayer));",
    ].join("\n");
    assert.strictEqual(
      useNamespaceImport(text, {
        specifier: "./http.ts",
        name: "orchestrationHttpApiLayer",
        alias: "OrchestrationHttp",
        member: "layer",
      }),
      [
        'import { other } from "./http.ts";',
        'import * as OrchestrationHttp from "./http.ts";',
        "const routes = build().pipe(Layer.provide(OrchestrationHttp.layer));",
      ].join("\n"),
    );
  });
});

describe("namespaceAlias", () => {
  it("names a module by its file, with the folder for generic file names", () => {
    assert.strictEqual(
      namespaceAlias("../persistence/OrchestrationEventStore.ts"),
      "OrchestrationEventStore",
    );
    assert.strictEqual(namespaceAlias("../orchestration-v2/http.ts"), "OrchestrationV2Http");
  });
});

describe("relativeSpecifier", () => {
  it("points from one file to another", () => {
    assert.strictEqual(
      relativeSpecifier("apps/server/src/cli/drive.ts", "apps/server/src/persistence/Sqlite.ts"),
      "../persistence/Sqlite.ts",
    );
    assert.strictEqual(
      relativeSpecifier("apps/server/src/provider/A.ts", "apps/server/src/provider/B.ts"),
      "./B.ts",
    );
  });
});
