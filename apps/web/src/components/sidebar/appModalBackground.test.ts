import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nextBackgroundView, resolveMainView } from "./appModalBackground";

describe("nextBackgroundView", () => {
  it("keeps the project page behind Settings and returns the same view when it closes", () => {
    const page = resolveMainView(null, "orchard");
    expect(page).toEqual({ kind: "project", projectKey: "orchard" });
    // Settings matches no thread or project, so the route's view is null while it is open.
    const underSettings = nextBackgroundView(page, null, true);
    expect(underSettings).toBe(page);
    expect(nextBackgroundView(underSettings, resolveMainView(null, "orchard"), false)).toBe(page);
  });

  it("follows the route to another view while nothing is open over it", () => {
    const page = resolveMainView(null, "orchard");
    const thread = resolveMainView(
      { kind: "server", threadRef: scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("t")) },
      null,
    );
    expect(nextBackgroundView(page, thread, false)).toBe(thread);
    expect(nextBackgroundView(thread, resolveMainView(null, "field-notes"), false)).toEqual({
      kind: "project",
      projectKey: "field-notes",
    });
  });
});
