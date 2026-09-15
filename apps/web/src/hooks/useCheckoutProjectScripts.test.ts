import type { ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveCheckoutActionState } from "./useCheckoutProjectScripts";

const fileAction: ProjectScript = {
  id: "file",
  name: "File",
  command: "vp file",
  icon: "play",
  runOnWorktreeCreate: false,
};
const localAction: ProjectScript = {
  id: "local",
  name: "Local",
  command: "vp local",
  icon: "configure",
  runOnWorktreeCreate: true,
};

describe("resolveCheckoutActionState", () => {
  it("uses local actions when styal.json is missing", () => {
    expect(
      resolveCheckoutActionState({
        status: "missing",
        source: null,
        fileScripts: [],
        localScripts: [localAction],
      }),
    ).toEqual({ actionSource: "local", scripts: [localAction] });
  });

  it("keeps t3.json as migration input rather than an action source", () => {
    expect(
      resolveCheckoutActionState({
        status: "valid",
        source: "t3.json",
        fileScripts: [],
        localScripts: [localAction],
      }),
    ).toEqual({ actionSource: "local", scripts: [localAction] });
  });

  it("uses only file actions once styal.json exists", () => {
    expect(
      resolveCheckoutActionState({
        status: "valid",
        source: "styal.json",
        fileScripts: [fileAction],
        localScripts: [localAction],
      }),
    ).toEqual({ actionSource: "styal.json", scripts: [fileAction] });
  });

  it("does not fall back while an invalid styal.json is present", () => {
    expect(
      resolveCheckoutActionState({
        status: "invalid",
        source: "styal.json",
        fileScripts: [],
        localScripts: [localAction],
      }),
    ).toEqual({ actionSource: "styal.json", scripts: [] });
  });
});
