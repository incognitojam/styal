import type {
  OrchestrationThreadActivity,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { OpenPreviewMutation } from "~/browser/openFileInPreview";

import {
  openScriptPreview,
  resolveScriptPreviewUrl,
  unfinishedSetupScriptStarts,
} from "./openScriptPreview";

const openBrowser = vi.fn();
let previewSupported = true;

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  rememberPreviewUrl: vi.fn(),
  isPreviewSupportedInRuntime: () => previewSupported,
}));

vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openBrowser }) },
}));

vi.mock("~/browserHistoryStore", () => ({
  recordVisitForThread: vi.fn(),
}));

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "tab-1",
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-08-15T00:00:00.000Z",
};

afterEach(() => {
  previewSupported = true;
  vi.clearAllMocks();
});

describe("resolveScriptPreviewUrl", () => {
  it("normalises a bare loopback host the way the URL bar does", () => {
    expect(resolveScriptPreviewUrl({ previewUrl: "localhost:5173", autoOpenPreview: true })).toBe(
      "http://localhost:5173/",
    );
  });

  it("opts out when autoOpenPreview is not set", () => {
    expect(resolveScriptPreviewUrl({ previewUrl: "localhost:5173" })).toBeNull();
    expect(
      resolveScriptPreviewUrl({ previewUrl: "localhost:5173", autoOpenPreview: false }),
    ).toBeNull();
  });

  it("opts out without a previewUrl", () => {
    expect(resolveScriptPreviewUrl({ autoOpenPreview: true })).toBeNull();
  });

  it("swallows a malformed previewUrl instead of throwing", () => {
    expect(resolveScriptPreviewUrl({ previewUrl: "not a url", autoOpenPreview: true })).toBeNull();
    expect(
      resolveScriptPreviewUrl({ previewUrl: "file:///etc/passwd", autoOpenPreview: true }),
    ).toBeNull();
  });
});

describe("openScriptPreview", () => {
  it("opens the panel at the normalised URL", async () => {
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

    await openScriptPreview({
      threadRef,
      script: { previewUrl: "localhost:5173", autoOpenPreview: true },
      openPreview,
    });

    expect(openPreview).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, url: "http://localhost:5173/" },
    });
    expect(openBrowser).toHaveBeenCalledWith(threadRef, "tab-1");
  });

  it("does not open the panel for a malformed previewUrl", async () => {
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

    await openScriptPreview({
      threadRef,
      script: { previewUrl: "not a url", autoOpenPreview: true },
      openPreview,
    });

    expect(openPreview).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("stays out of the way when the runtime has no preview bridge", async () => {
    previewSupported = false;
    const openPreview = vi.fn(async () => AsyncResult.success(snapshot));

    await openScriptPreview({
      threadRef,
      script: { previewUrl: "localhost:5173", autoOpenPreview: true },
      openPreview,
    });

    expect(openPreview).not.toHaveBeenCalled();
  });

  it("leaves the panel closed when the preview session fails to open", async () => {
    const openPreview: OpenPreviewMutation<Error> = async () =>
      AsyncResult.failure(Cause.fail(new Error("unreachable")));

    await openScriptPreview({
      threadRef,
      script: { previewUrl: "localhost:5173", autoOpenPreview: true },
      openPreview,
    });

    expect(openBrowser).not.toHaveBeenCalled();
  });
});

function activity(input: {
  id: string;
  kind: string;
  payload: unknown;
}): OrchestrationThreadActivity {
  return {
    id: input.id as OrchestrationThreadActivity["id"],
    tone: "info",
    kind: input.kind,
    summary: input.kind,
    payload: input.payload,
    turnId: null,
    createdAt: "2026-08-15T00:00:00.000Z" as OrchestrationThreadActivity["createdAt"],
  };
}

describe("unfinishedSetupScriptStarts", () => {
  it("reports a started run that has not finished", () => {
    expect(
      unfinishedSetupScriptStarts([
        activity({
          id: "a1",
          kind: "setup-script.requested",
          payload: { runId: "run-1", scriptId: "dev" },
        }),
        activity({
          id: "a2",
          kind: "setup-script.started",
          payload: { runId: "run-1", scriptId: "dev" },
        }),
      ]),
    ).toEqual([{ activityId: "a2", scriptId: "dev" }]);
  });

  it("drops a run that already finished, so a replayed thread reopens nothing", () => {
    for (const terminalKind of ["setup-script.completed", "setup-script.failed"]) {
      expect(
        unfinishedSetupScriptStarts([
          activity({
            id: "a2",
            kind: "setup-script.started",
            payload: { runId: "run-1", scriptId: "dev" },
          }),
          activity({ id: "a3", kind: terminalKind, payload: { runId: "run-1", exitCode: 0 } }),
        ]),
      ).toEqual([]);
    }
  });

  it("ignores unrelated activity and payloads without a script id", () => {
    expect(
      unfinishedSetupScriptStarts([
        activity({ id: "a1", kind: "runtime.info", payload: { runId: "run-1", scriptId: "dev" } }),
        activity({ id: "a2", kind: "setup-script.started", payload: { runId: "run-2" } }),
        activity({ id: "a3", kind: "setup-script.started", payload: null }),
      ]),
    ).toEqual([]);
  });
});
