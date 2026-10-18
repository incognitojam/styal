import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";

const state = vi.hoisted(() => ({ onboarding: vi.fn(() => null) }));
vi.mock(import("../hostedPairing"), async (original) => ({
  ...(await original()),
  isHostedStaticApp: () => true,
}));
vi.mock(import("../cloud/publicConfig"), async (original) => ({
  ...(await original()),
  hasCloudPublicConfig: () => true,
}));
vi.mock(import("../components/promptLinks/HostedPromptLinkLanding"), async (original) => ({
  ...(await original()),
  useHostedPromptLinkLanding: () => null,
}));
vi.mock(import("../components/AppSidebarLayout"), async (original) => ({
  ...(await original()),
  AppSidebarLayout: (({ children }: { children: ReactNode }) => children) as never,
}));
vi.mock(import("../components/CommandPalette"), async (original) => ({
  ...(await original()),
  CommandPalette: (({ children }: { children: ReactNode }) => children) as never,
}));
vi.mock(import("../components/cloud/ConnectOnboardingDialog"), async (original) => ({
  ...(await original()),
  ConnectOnboardingDialog: state.onboarding,
}));
vi.mock(import("../components/relay-auth/RelayAccountDialog"), async (original) => ({
  ...(await original()),
  RelayAccountDialog: (() => null) as never,
}));
vi.mock(import("../components/relay-auth/RelayEmailSignInForm"), async (original) => ({
  ...(await original()),
  RelayEmailSignInForm: () => <p>Email code sign-in</p>,
}));
vi.mock(import("../components/CustomSnoozeDialog"), async (original) => ({
  ...(await original()),
  CustomSnoozeDialogHost: () => null,
}));
vi.mock(import("../components/chat/GuestShareControls"), async (original) => ({
  ...(await original()),
  GuestShareDialogHost: () => null,
}));

import {
  openRelaySignIn,
  relaySignInDialogOpenAtom,
} from "../components/relay-auth/relayAuthDialogs";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { Route } from "./__root";

// The welcome page is replaced by a button that opens relay sign-in the way the page does.
const welcomeRoute = createRoute({
  getParentRoute: () => Route,
  path: "/welcome",
  component: () => (
    <button type="button" onClick={openRelaySignIn}>
      Sign in
    </button>
  ),
});

function resetSignIn(): Disposable {
  appAtomRegistry.set(relaySignInDialogOpenAtom, false);
  state.onboarding.mockClear();
  return { [Symbol.dispose]: () => appAtomRegistry.set(relaySignInDialogOpenAtom, false) };
}

describe("welcome route relay authentication", () => {
  it("opens email sign-in while keeping post-sign-in onboarding suspended", async () => {
    using _signIn = resetSignIn();
    const router = createRouter({
      routeTree: Route.addChildren([welcomeRoute]),
      history: createMemoryHistory({ initialEntries: ["/welcome"] }),
      disableGlobalCatchBoundary: true,
    });
    await using screen = await render(
      <AppAtomRegistryProvider>
        <RouterProvider router={router} />
      </AppAtomRegistryProvider>,
      { router: false },
    );

    await screen.getByRole("button", { name: "Sign in" }).click();

    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByText("Email code sign-in")).toBeVisible();
    expect(state.onboarding).not.toHaveBeenCalled();
  });
});
