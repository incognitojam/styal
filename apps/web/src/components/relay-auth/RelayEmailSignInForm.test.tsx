import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const run = vi.hoisted(() =>
  vi.fn(async () => ({ _tag: "Success", value: { resendAfterSeconds: 10 } })),
);
vi.mock("../../lib/runtime", () => ({ runtime: { runPromiseExit: run } }));
vi.mock("../../cloud/relaySession", () => ({
  startEmailSignIn: vi.fn(),
  verifyEmailSignIn: vi.fn(),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/label", () => ({ Label: "label" }));

import { RelayEmailSignInForm } from "./RelayEmailSignInForm";

let renderer: ReactTestRenderer;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  run.mockClear();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    renderer = create(<RelayEmailSignInForm />);
  });
}

describe("email sign-in origin requirements", () => {
  it("explains how to sign in on an insecure LAN page without making requests", async () => {
    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("crypto", {});
    await mount();
    expect(renderer.root.findByProps({ role: "alert" }).children.join(" ")).toContain(
      "HTTPS or localhost",
    );
    expect(renderer.root.findAllByType("form")).toHaveLength(0);
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("also explains the requirement when WebCrypto is missing", async () => {
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("crypto", {});
    await mount();
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(1);
    expect(renderer.root.findAllByType("form")).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("sends the email code from a secure origin", async () => {
    vi.stubGlobal("window", { isSecureContext: true });
    await mount();
    await act(async () =>
      renderer.root
        .findByType("input")
        .props.onChange({ target: { value: "synthetic@example.test" } }),
    );
    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(run).toHaveBeenCalledOnce();
    expect(renderer.root.findByType("input").props.autoComplete).toBe("one-time-code");
  });
});
