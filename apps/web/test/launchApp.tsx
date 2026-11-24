// One page load of the whole app against fakeEnvironment.ts, for tests of where a launch lands.
// The launch is once per page load, so each such test file holds one launch, and uses its own
// environment so the persisted shell caches of other files cannot make it start warm.
import { createMemoryHistory } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { expect, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useLaunchNavigationStore } from "~/launchNavigationStore";
import { getRouter, type AppRouter } from "~/router";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryServerWelcomeAtom } from "~/state/server";
import { environmentShell } from "~/state/shell";
import { installFakeEnvironment, threadWithHistory } from "./fakeEnvironment";
import { act, render } from "./render";

export const BOOTSTRAP_THREAD = threadWithHistory("bootstrap", 1);
// A second thread, so the workspace is not the server's fresh cwd bootstrap.
const OTHER_THREAD = threadWithHistory("other", 1);

export interface LaunchedApp extends AsyncDisposable {
  readonly router: AppRouter;
  readonly pathname: () => string;
  readonly navigate: (to: "/" | "/settings/general") => Promise<void>;
}

export function shellState(environmentId: EnvironmentId) {
  return appAtomRegistry.get(environmentShell.stateValueAtom(environmentId));
}

/** Installs the environment and loads the router; `beforeRender` runs before the app mounts. */
export async function launchApp(
  path: string,
  environmentId: EnvironmentId,
  beforeRender?: () => Promise<void>,
): Promise<LaunchedApp> {
  await using stack = new AsyncDisposableStack();
  stack.use(installFakeEnvironment([BOOTSTRAP_THREAD, OTHER_THREAD], { environmentId }));
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  await beforeRender?.();
  stack.use(await render(<AppRoot router={router} />, { router: false }));
  const owned = stack.move();
  return {
    router,
    pathname: () => router.state.location.pathname,
    navigate: (to) => act(() => router.navigate({ to })),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

/** Waits until the app has rendered the primary project, which no welcome has named yet. */
export async function waitForProjectRows() {
  await expect.element(page.getByText("render", { exact: true }).first()).toBeInTheDocument();
  expect(appAtomRegistry.get(primaryServerWelcomeAtom)).toBeNull();
}

/** Home shows nothing and has not started a draft. */
export function expectHomeHolding(app: LaunchedApp) {
  expect(app.pathname()).toBe("/");
  expect(page.getByRole("main").elements()).toEqual([]);
  expect(useLaunchNavigationStore.getState().owner).toBeNull();
  expect(useLaunchNavigationStore.getState().launchPending).toBe(true);
}

/**
 * Home started its draft: it holds the launch while the draft opens, or the draft is open. The
 * fake server can leave the draft's project file read unanswered, so the draft may never open.
 */
export async function expectDraftStarted(app: LaunchedApp) {
  await vi.waitFor(() =>
    expect(
      useLaunchNavigationStore.getState().owner === "index-draft" ||
        app.pathname().startsWith("/draft/"),
    ).toBe(true),
  );
}
