import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  resolveThreadActionProjectRef,
  resolveNewDraftStartFromOrigin,
  startNewThreadFromContext,
  type ChatThreadActionContext,
} from "./chatThreadActions";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("environment-2");
const PROJECT_ID = ProjectId.make("project-1");
const FALLBACK_PROJECT_ID = ProjectId.make("project-2");
const SCOPED_PROJECT_ID = ProjectId.make("project-3");

/** A filter target whose group spans two environments. */
const SCOPED_PROJECT_GROUP = {
  environmentId: ENVIRONMENT_ID,
  id: SCOPED_PROJECT_ID,
  memberProjectRefs: [
    scopeProjectRef(ENVIRONMENT_ID, SCOPED_PROJECT_ID),
    scopeProjectRef(REMOTE_ENVIRONMENT_ID, SCOPED_PROJECT_ID),
  ],
};

function createContext(overrides: Partial<ChatThreadActionContext> = {}): ChatThreadActionContext {
  return {
    activeDraftThread: null,
    activeThread: undefined,
    defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
    handleNewThread: async () => {},
    ...overrides,
  };
}

describe("chatThreadActions", () => {
  it("only applies the start-from-origin default to new worktree drafts", () => {
    expect(
      resolveNewDraftStartFromOrigin({
        envMode: "worktree",
        newWorktreesStartFromOrigin: true,
      }),
    ).toBe(true);
    expect(
      resolveNewDraftStartFromOrigin({
        envMode: "local",
        newWorktreesStartFromOrigin: true,
      }),
    ).toBe(false);
  });

  it("prefers the active thread project when resolving thread actions", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
        },
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("falls back to the active draft thread project when there is no active thread", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeDraftThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
        },
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("falls back to the default project ref when there is no active thread context", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("prefers the sidebar's project filter over the active thread for the sidebar button", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
        },
        scopedProjectGroup: SCOPED_PROJECT_GROUP,
      }),
      "sidebar",
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, SCOPED_PROJECT_ID));
  });

  it("keeps contextual commands on the active thread's project despite the filter", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
        },
        scopedProjectGroup: SCOPED_PROJECT_GROUP,
      }),
      "contextual",
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("lets the filter beat the fallback default for contextual commands", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        scopedProjectGroup: SCOPED_PROJECT_GROUP,
      }),
      "contextual",
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, SCOPED_PROJECT_ID));
  });

  it("stays on the active thread's group member when it belongs to the filtered group", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeThread: {
          environmentId: REMOTE_ENVIRONMENT_ID,
          projectId: SCOPED_PROJECT_ID,
        },
        scopedProjectGroup: SCOPED_PROJECT_GROUP,
      }),
      "sidebar",
    );

    expect(projectRef).toEqual(scopeProjectRef(REMOTE_ENVIRONMENT_ID, SCOPED_PROJECT_ID));
  });

  it("uses the filtered project when there is no thread context at all", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        defaultProjectRef: null,
        scopedProjectGroup: SCOPED_PROJECT_GROUP,
      }),
      "sidebar",
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, SCOPED_PROJECT_ID));
  });


  it("inherits only the project from context, never branch or worktree state", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewThreadFromContext(
      createContext({
        activeThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
        },
        handleNewThread,
      }),
    );

    expect(didStart).toBe(true);
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("does not start a thread when there is no project context", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewThreadFromContext(
      createContext({
        defaultProjectRef: null,
        handleNewThread,
      }),
    );

    expect(didStart).toBe(false);
    expect(handleNewThread).not.toHaveBeenCalled();
  });
});
