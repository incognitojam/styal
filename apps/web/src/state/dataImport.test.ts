import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { importLegacyData, legacyImportPendingCount, legacyImportRequestKey } from "./dataImport";

describe("legacy import command key", () => {
  const environmentId = EnvironmentId.make("environment-1");

  it("separates project and preference requests in the same environment", () => {
    const projects = legacyImportRequestKey({
      environmentId,
      input: { projectIds: ["project-1"], includeSettings: false },
    });
    const preferences = legacyImportRequestKey({
      environmentId,
      input: { projectIds: [], includeSettings: true },
    });

    expect(projects).not.toBe(preferences);
  });

  it("shares an identical request", () => {
    const target = {
      environmentId,
      input: { projectIds: ["project-1"], includeSettings: false },
    } as const;

    expect(legacyImportRequestKey(target)).toBe(legacyImportRequestKey(structuredClone(target)));
  });

  it("owns pending state for the full command promise", async () => {
    const registry = AtomRegistry.make();
    const result = importLegacyData.run(registry, {
      environmentId,
      input: { projectIds: [], includeSettings: true },
    });

    expect(registry.get(legacyImportPendingCount)).toBe(1);
    await result;
    expect(registry.get(legacyImportPendingCount)).toBe(0);
    registry.dispose();
  });
});
