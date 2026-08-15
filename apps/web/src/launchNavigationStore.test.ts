import { ProjectId, type ServerLifecycleWelcomePayload, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  bootstrapWelcomeKey,
  decideBootstrapLaunch,
  indexDraftStartNeedsRetry,
  isBootstrapWelcomePending,
  useLaunchNavigationStore,
} from "./launchNavigationStore";

const welcome = {
  environment: { environmentId: "env-test" },
  bootstrapProjectId: ProjectId.make("project-test"),
  bootstrapThreadId: ThreadId.make("thread-test"),
} as ServerLifecycleWelcomePayload;

describe("launch navigation store", () => {
  beforeEach(() => {
    useLaunchNavigationStore.setState({ owner: null, handledBootstrapKey: null });
  });

  it("allows only one automatic launch navigation at a time", () => {
    const store = useLaunchNavigationStore.getState();

    expect(store.claim("index-draft")).toBe(true);
    expect(store.claim("server-bootstrap")).toBe(false);
    store.release("server-bootstrap");
    expect(useLaunchNavigationStore.getState().owner).toBe("index-draft");
    store.release("index-draft");
    expect(useLaunchNavigationStore.getState().owner).toBe(null);
  });

  it("tracks a bootstrap route by environment and thread", () => {
    const key = bootstrapWelcomeKey(welcome);
    expect(key).toBe("env-test\0thread-test");
    expect(isBootstrapWelcomePending(welcome, null)).toBe(true);

    useLaunchNavigationStore.getState().markBootstrapHandled(key!);
    expect(useLaunchNavigationStore.getState().handledBootstrapKey).toBe(key);
    expect(isBootstrapWelcomePending(welcome, key)).toBe(false);
  });

  it("does not create a key for a normal welcome", () => {
    expect(
      bootstrapWelcomeKey({
        ...welcome,
        bootstrapProjectId: undefined,
        bootstrapThreadId: undefined,
      }),
    ).toBe(null);
  });

  it("routes a pending bootstrap only while the root is unclaimed", () => {
    expect(
      decideBootstrapLaunch({
        welcome,
        handledBootstrapKey: null,
        pathname: "/",
        owner: null,
      }),
    ).toEqual({ type: "navigate", bootstrapKey: "env-test\0thread-test" });

    expect(
      decideBootstrapLaunch({
        welcome,
        handledBootstrapKey: null,
        pathname: "/",
        owner: "index-draft",
      }),
    ).toEqual({ type: "mark-handled", bootstrapKey: "env-test\0thread-test" });

    expect(
      decideBootstrapLaunch({
        welcome,
        handledBootstrapKey: null,
        pathname: "/draft/draft-test",
        owner: null,
      }),
    ).toEqual({ type: "mark-handled", bootstrapKey: "env-test\0thread-test" });
  });

  it("ignores an already handled bootstrap on later visits to home", () => {
    expect(
      decideBootstrapLaunch({
        welcome,
        handledBootstrapKey: "env-test\0thread-test",
        pathname: "/",
        owner: null,
      }),
    ).toEqual({ type: "ignore" });
  });

  it("retries when a concurrent draft operation wins without navigating", () => {
    expect(indexDraftStartNeedsRetry(null)).toBe(true);
    expect(indexDraftStartNeedsRetry({ draftId: "draft-test", threadId: "thread-test" })).toBe(
      false,
    );
  });
});
