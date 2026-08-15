import { ProjectId, type ServerLifecycleWelcomePayload, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  bootstrapWelcomeKey,
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
});
