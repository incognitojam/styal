import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useDiffPanelSessionStore, useDiffPanelStore } from "./diffPanelStore";

describe("diffPanelStore", () => {
  beforeEach(() => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      diffSortMode: "smart",
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
  });

  it("retains fold choices when a panel consumer returns with fresh defaults", () => {
    const scopeKey = "environment-1:thread-1:branch";
    const defaults = new Set(["src/app.ts", "src/index.ts"]);
    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, defaults, (current) => {
      const next = new Set(current);
      next.delete("src/app.ts");
      return next;
    });

    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(["src/index.ts"]),
    );

    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, new Set(), (current) => {
      const next = new Set(current);
      next.delete("src/index.ts");
      return next;
    });
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );

    useDiffPanelSessionStore
      .getState()
      .updateCollapsedFileKeys(scopeKey, defaults, (current) => current);
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );
    expect(defaults).toEqual(new Set(["src/app.ts", "src/index.ts"]));
  });

  it("keeps the selected sort mode in panel and persisted state", async () => {
    useDiffPanelStore.getState().setDiffSortMode("alphabetical");

    expect(useDiffPanelStore.getState().diffSortMode).toBe("alphabetical");
    expect(
      useDiffPanelStore.persist.getOptions().partialize?.(useDiffPanelStore.getState()),
    ).toMatchObject({ diffSortMode: "alphabetical" });

    const { name, storage } = useDiffPanelStore.persist.getOptions();
    if (!name) throw new Error("Expected diff panel persistence to have a storage name");
    const persisted = await storage?.getItem(name);
    expect(persisted?.state).toMatchObject({ diffSortMode: "alphabetical" });

    useDiffPanelStore.setState({ diffSortMode: "smart" });
    if (persisted) await storage?.setItem(name, persisted);
    await useDiffPanelStore.persist.rehydrate();

    expect(useDiffPanelStore.getState().diffSortMode).toBe("alphabetical");
  });
});
