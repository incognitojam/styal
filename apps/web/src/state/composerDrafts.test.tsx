import {
  EnvironmentId,
  ThreadId,
  type ComposerDraftSnapshot,
  type ComposerDraftUpdateInput,
  type ComposerDraftUpdateResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import { markComposerDraftSent, useServerComposerDraftSync } from "./composerDrafts";

const sync = vi.hoisted(() => ({
  snapshot: null as ComposerDraftSnapshot | null,
  update:
    vi.fn<
      (
        registry: unknown,
        request: { environmentId: EnvironmentId; input: ComposerDraftUpdateInput },
      ) => Promise<AsyncResult.AsyncResult<ComposerDraftUpdateResult, string>>
    >(),
}));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: null }));
vi.mock("./server", () => ({ serverEnvironment: { configValueAtom: () => "config" } }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "config"
      ? { environment: { capabilities: { composerDraftSync: true } } }
      : sync.snapshot === null
        ? null
        : AsyncResult.success(sync.snapshot),
}));
vi.mock("@t3tools/client-runtime/state/composer-drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/composer-drafts")>()),
  createComposerDraftEnvironmentAtoms: () => ({
    changes: () => Atom.make(null),
    update: { run: sync.update },
  }),
}));

let renderer: ReactTestRenderer | undefined;
let threadRef: { environmentId: EnvironmentId; threadId: ThreadId };
let nextThreadId = 0;

function Probe() {
  useServerComposerDraftSync(threadRef);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  threadRef = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make(`thread-${++nextThreadId}`),
  };
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  sync.snapshot = {
    threadId: threadRef.threadId,
    revision: 0,
    common: null,
    clientMutationId: null,
    updatedAt: null,
  };
  sync.update.mockReset();
  sync.update.mockResolvedValue(AsyncResult.failure(Cause.fail("offline")));
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("web composer draft sync", () => {
  it.each([null, "full-access"] as const)(
    "does not autosave sent text before rendering the clear with %s preferences",
    async (runtimeMode) => {
      if (runtimeMode !== null)
        useComposerDraftStore.getState().setRuntimeMode(threadRef, runtimeMode);
      await act(() => {
        renderer = create(<Probe />);
      });
      await act(() => {
        useComposerDraftStore.getState().setPrompt(threadRef, "sent message");
      });

      await act(async () => {
        useComposerDraftStore.getState().clearComposerContent(threadRef);
        markComposerDraftSent(threadRef, "sent message");
        // A due autosave can run before React commits the cleared store value.
        vi.advanceTimersByTime(1_200);
      });

      expect(sync.update.mock.calls.map(([, request]) => request.input.common?.text)).not.toContain(
        "sent message",
      );
      expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt ?? "").toBe("");
    },
  );

  it("autosaves a new edit made after sending before React renders it", async () => {
    await act(() => {
      renderer = create(<Probe />);
    });
    await act(() => {
      useComposerDraftStore.getState().setPrompt(threadRef, "sent message");
    });

    await act(async () => {
      useComposerDraftStore.getState().clearComposerContent(threadRef);
      markComposerDraftSent(threadRef, "sent message");
      useComposerDraftStore.getState().setPrompt(threadRef, "next message");
      vi.advanceTimersByTime(1_200);
    });

    expect(sync.update).toHaveBeenCalledOnce();
    expect(sync.update.mock.calls[0]?.[1].input.common?.text).toBe("next message");
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
      "next message",
    );
  });

  it("uses the live cleared draft when a pending autosave reply schedules its retry", async () => {
    let resolveAutosave!: (
      result: AsyncResult.AsyncResult<ComposerDraftUpdateResult, string>,
    ) => void;
    const autosave = new Promise<AsyncResult.AsyncResult<ComposerDraftUpdateResult, string>>(
      (resolve) => {
        resolveAutosave = resolve;
      },
    );
    sync.update.mockReturnValueOnce(autosave);
    await act(() => {
      renderer = create(<Probe />);
    });
    await act(() => {
      useComposerDraftStore.getState().setPrompt(threadRef, "sent message");
    });
    await act(async () => {
      vi.advanceTimersByTime(1_200);
    });

    await act(async () => {
      useComposerDraftStore.getState().clearComposerContent(threadRef);
      markComposerDraftSent(threadRef, "sent message");
      const input = sync.update.mock.calls[0]![1].input;
      resolveAutosave(
        AsyncResult.success({
          _tag: "accepted",
          snapshot: {
            ...sync.snapshot!,
            revision: 1,
            common: input.common,
            clientMutationId: input.clientMutationId,
          },
        }),
      );
      // Resolve the RPC before committing the render, then fire the retry it schedules.
      await autosave;
      await Promise.resolve();
      vi.advanceTimersByTime(1_200);
    });

    expect(sync.update.mock.calls.map(([, request]) => request.input.common)).toEqual([
      { text: "sent message", modelSelection: null, runtimeMode: null, interactionMode: null },
      null,
    ]);
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt ?? "").toBe("");
  });
});
