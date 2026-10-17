import {
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  type PullRequestDetailView,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const permissions = vi.hoisted(() => ({
  allowed: new Set<string>(),
  listeners: new Set<() => void>(),
}));

vi.mock(import("~/state/session"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const canWrite = (environmentId: string | null, scope: string) =>
    scope === AuthSourceControlWriteScope && permissions.allowed.has(environmentId ?? "");
  return {
    ...(await original()),
    readEnvironmentScope: canWrite,
    useEnvironmentScope: (environmentId, scope) =>
      useSyncExternalStore(
        (listener) => {
          permissions.listeners.add(listener);
          return () => permissions.listeners.delete(listener);
        },
        () => canWrite(environmentId, scope),
      ),
  };
});

import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "Original description",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "Unit tests", status: "success", description: null, url: null }],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: true,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: true },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");
const onSave = vi.fn<(next: string) => void>();
const onCancel = vi.fn<() => void>();
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  permissions.allowed.clear();
  permissions.listeners.clear();
  onSave.mockReset();
  onCancel.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function openEditor(options?: { value?: string; allowEmpty?: boolean }) {
  await act(async () =>
    root.render(
      <PullRequestMarkdownEditor
        value={options?.value ?? "Original description"}
        detail={detail}
        environmentId={secondary}
        label="Pull request description"
        saving={false}
        allowEmpty={options?.allowEmpty ?? false}
        onSave={onSave}
        onCancel={onCancel}
      />,
    ),
  );
}

function button(label: string) {
  const match = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  expect(match, `button ${label}`).toBeDefined();
  return match!;
}

const clickSave = () => act(async () => button("Save").click());

async function grant(allowed: boolean) {
  await act(async () => {
    if (allowed) permissions.allowed.add(secondary);
    else permissions.allowed.delete(secondary);
    permissions.listeners.forEach((listener) => listener());
  });
}

it("does not save a secondary environment's description using the primary grant", async () => {
  permissions.allowed.add(primary);
  await openEditor();

  expect(button("Save").disabled).toBe(true);
  await clickSave();

  expect(onSave).not.toHaveBeenCalled();
});

it("rejects a Save click when the grant changes before React updates", async () => {
  permissions.allowed.add(secondary);
  await openEditor();
  permissions.allowed.delete(secondary);

  expect(button("Save").disabled).toBe(false);
  await clickSave();

  expect(onSave).not.toHaveBeenCalled();
});

it("keeps an edited draft through revocation and saves it after access returns without remounting", async () => {
  permissions.allowed.add(secondary);
  await openEditor();
  const textarea = container.querySelector("textarea")!;
  await userEvent.clear(textarea);
  await userEvent.type(textarea, "Keep these unsaved edits");

  await grant(false);
  expect(button("Save").disabled).toBe(true);
  expect(container.querySelector("textarea")).toBe(textarea);

  await grant(true);
  await clickSave();
  expect(onSave).toHaveBeenCalledExactlyOnceWith("Keep these unsaved edits");
});

it("saves with source-control permission alone, from the button or Cmd/Ctrl+Enter", async () => {
  permissions.allowed.add(secondary);
  await openEditor();

  await clickSave();
  expect(onSave).toHaveBeenCalledExactlyOnceWith("Original description");

  container.querySelector("textarea")!.focus();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(onSave).toHaveBeenCalledTimes(2);
});

it("allows clearing a description only after a pending grant becomes available", async () => {
  await openEditor({ value: "", allowEmpty: true });
  await clickSave();
  expect(onSave).not.toHaveBeenCalled();

  await grant(true);
  await clickSave();
  expect(onSave).toHaveBeenCalledExactlyOnceWith("");
});

it("keeps cancelling a local edit available without a write grant", async () => {
  await openEditor();

  await act(async () => button("Cancel").click());
  container.querySelector("textarea")!.focus();
  await userEvent.keyboard("{Escape}");

  expect(onCancel).toHaveBeenCalledTimes(2);
  expect(onSave).not.toHaveBeenCalled();
});
