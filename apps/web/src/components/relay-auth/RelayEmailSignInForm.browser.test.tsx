import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, stubGlobal } from "../../../test/render";

const run = vi.hoisted(() =>
  vi.fn(async () => ({ _tag: "Success", value: { resendAfterSeconds: 10 } })),
);
vi.mock(import("../../lib/runtime"), async (original) => ({
  ...(await original()),
  runtime: { runPromiseExit: run } as never,
}));
vi.mock(import("../../cloud/relaySession"), async (original) => ({
  ...(await original()),
  startEmailSignIn: vi.fn() as never,
  verifyEmailSignIn: vi.fn() as never,
}));

import { RelayEmailSignInForm } from "./RelayEmailSignInForm";

describe("email sign-in origin requirements", () => {
  it("explains how to sign in on an insecure LAN page without making requests", async () => {
    run.mockClear();
    using _secure = stubGlobal("isSecureContext", false);
    using _crypto = stubGlobal("crypto", {});
    await using screen = await render(<RelayEmailSignInForm />);
    expect(screen.getByRole("alert").element().textContent).toContain("HTTPS or localhost");
    expect(screen.container.querySelectorAll("form")).toHaveLength(0);
    expect(screen.container.querySelectorAll("input")).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("also explains the requirement when WebCrypto is missing", async () => {
    run.mockClear();
    using _secure = stubGlobal("isSecureContext", true);
    using _crypto = stubGlobal("crypto", {});
    await using screen = await render(<RelayEmailSignInForm />);
    expect(screen.getByRole("alert").elements()).toHaveLength(1);
    expect(screen.container.querySelectorAll("form")).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("sends the email code from a secure origin", async () => {
    run.mockClear();
    using _secure = stubGlobal("isSecureContext", true);
    await using screen = await render(<RelayEmailSignInForm />);
    await userEvent.fill(screen.getByLabelText("Email"), "synthetic@example.test");
    await userEvent.click(screen.getByRole("button", { name: "Send code" }));
    await expect
      .element(screen.getByLabelText("Code"))
      .toHaveAttribute("autocomplete", "one-time-code");
    expect(run).toHaveBeenCalledOnce();
  });
});
