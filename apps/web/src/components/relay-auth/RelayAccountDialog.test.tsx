import { act, create } from "react-test-renderer";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  current: null as unknown,
  pending: [] as Array<{ resolve: (value: unknown[]) => void }>,
  runExit: null as null | ((effect: unknown) => Promise<unknown>),
}));
vi.mock("../../cloud/useRelayAccount", () => ({ useRelayAccount: () => state.current }));
vi.mock("../../cloud/relaySession", () => ({ signOutOfRelay: null, deleteRelayAccount: null }));
vi.mock("../../lib/runtime", () => ({
  runtime: { runPromiseExit: (effect: unknown) => state.runExit!(effect) },
}));
vi.mock("../clerk/T3ConnectUserProfilePage", () => ({ T3ConnectUserProfilePage: () => null }));
vi.mock("../clerk/MobileClientsUserProfilePage", () => ({
  MobileClientsUserProfilePage: () => null,
}));
vi.mock("../clerk/ClerkUserProfilePage", () => ({
  ClerkUserProfilePage: ({
    action,
    children,
  }: import("react").PropsWithChildren<{ action: import("react").ReactNode }>) => (
    <section>
      {action}
      {children}
    </section>
  ),
  ClerkUserProfileRefreshButton: "button",
  ClerkUserProfileRow: "li",
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/badge", () => ({ Badge: "span" }));
vi.mock("../ui/dialog", () => ({
  Dialog: "div",
  DialogDescription: "p",
  DialogFooter: "footer",
  DialogHeader: "header",
  DialogPanel: "main",
  DialogPopup: "article",
  DialogTitle: "h1",
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: "div",
  AlertDialogClose: "button",
  AlertDialogDescription: "p",
  AlertDialogFooter: "footer",
  AlertDialogHeader: "header",
  AlertDialogPopup: "article",
  AlertDialogTitle: "h2",
}));

import { RelayAccountDialog } from "./RelayAccountDialog";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { relayAccountDialogOpenAtom } from "./relayAuthDialogs";

function account(id: string) {
  return {
    isSignedIn: true,
    email: `${id}@example.test`,
    session: { accountId: id, credential: { accountId: id, refreshToken: `synthetic-${id}` } },
  };
}
function device(id: string) {
  return {
    sessionId: `session-${id}`,
    clientId: "t3-web",
    label: `Synthetic device ${id}`,
    current: false,
    lastUsedAt: "2026-10-18T12:00:00Z",
  };
}
function visibleText(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(visibleText).join(" ");
  if (typeof node === "object" && node !== null && "children" in node)
    return visibleText(node.children);
  return "";
}

let renderer: ReturnType<typeof create>;
const view = () => createElement(AppAtomRegistryProvider, null, createElement(RelayAccountDialog));
const renderedText = () => visibleText(renderer.toJSON());
async function mount() {
  await act(async () => {
    renderer = create(view());
  });
}
async function resolve(index: number, entries: unknown[]) {
  await act(async () => {
    state.pending[index]!.resolve(entries);
  });
}
async function switchAccount(id: string) {
  state.current = account(id);
  await act(async () => renderer.update(view()));
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.pending = [];
  appAtomRegistry.set(relayAccountDialogOpenAtom, true);
  state.current = account("old-account");
  state.runExit = () =>
    new Promise((complete) => {
      state.pending.push({ resolve: (value) => complete({ _tag: "Success", value }) });
    });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
});

describe("signed-in device listing", () => {
  it("ignores an old account's delayed device listing", async () => {
    await mount();
    await switchAccount("new-account");
    await resolve(1, [device("new-account")]);
    await resolve(0, [device("old-account")]);
    expect(renderedText()).toContain("new-account@example.test");
    expect(renderedText()).not.toContain("Synthetic device old-account");
    expect(renderedText()).toContain("Synthetic device new-account");
  });

  it("clears the previous identity's devices before the next load completes", async () => {
    await mount();
    await resolve(0, [device("old-account")]);
    expect(renderedText()).toContain("Synthetic device old-account");
    await switchAccount("new-account");
    expect(renderedText()).not.toContain("Synthetic device old-account");
    expect(state.pending).toHaveLength(2);
  });

  it("ignores an obsolete load for the same identity", async () => {
    await mount();
    await act(async () => renderer.root.findByProps({ isPending: true }).props.onClick());
    await resolve(1, [device("latest")]);
    await resolve(0, [device("obsolete")]);
    expect(renderedText()).toContain("Synthetic device latest");
    expect(renderedText()).not.toContain("Synthetic device obsolete");
  });

  it("does not reload an old identity after its pending revoke finishes", async () => {
    await mount();
    await resolve(0, [device("old-account")]);
    await act(async () =>
      renderer.root.findByProps({ size: "sm", variant: "outline" }).props.onClick(),
    );
    await switchAccount("new-account");
    await resolve(2, [device("new-account")]);
    await resolve(1, []);
    expect(state.pending).toHaveLength(3);
    expect(renderedText()).toContain("Synthetic device new-account");
    expect(renderedText()).not.toContain("Synthetic device old-account");
  });
});
