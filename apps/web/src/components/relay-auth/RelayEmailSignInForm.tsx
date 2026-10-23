import { type FormEvent, useEffect, useRef, useState } from "react";

import { runtime } from "../../lib/runtime";
import { startEmailSignIn, verifyEmailSignIn } from "../../cloud/relaySession";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  looksLikeEmail,
  normalizeSignInCode,
  SIGN_IN_CODE_LENGTH,
  signInFailureMessage,
} from "./RelayEmailSignInForm.logic";

type Step = { readonly kind: "email" } | { readonly kind: "code"; readonly email: string };

/** Email first, then the eight-digit code from the email. */
export function RelayEmailSignInForm({
  autoFocus = true,
  onSignedIn,
}: {
  readonly autoFocus?: boolean;
  readonly onSignedIn?: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canResend, setCanResend] = useState(false);
  const resendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resendTimer.current) clearTimeout(resendTimer.current);
    },
    [],
  );

  const sendCode = async (address: string) => {
    setPending(true);
    setError(null);
    const exit = await runtime.runPromiseExit(startEmailSignIn(address));
    setPending(false);
    if (exit._tag === "Failure") {
      setError(signInFailureMessage(exit));
      return;
    }
    setStep({ kind: "code", email: address });
    setCode("");
    setCanResend(false);
    if (resendTimer.current) clearTimeout(resendTimer.current);
    resendTimer.current = setTimeout(
      () => setCanResend(true),
      exit.value.resendAfterSeconds * 1_000,
    );
  };

  const verify = async (address: string, value: string) => {
    setPending(true);
    setError(null);
    const exit = await runtime.runPromiseExit(verifyEmailSignIn({ email: address, code: value }));
    setPending(false);
    if (exit._tag === "Failure") {
      setError(signInFailureMessage(exit));
      setCode("");
      return;
    }
    if (exit.value) onSignedIn?.();
    else setError("Your sign-in changed while this request was running. Try again.");
  };

  const submitEmail = (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!looksLikeEmail(address)) {
      setError("Enter an email address.");
      return;
    }
    void sendCode(address);
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    if (step.kind !== "code" || code.length !== SIGN_IN_CODE_LENGTH) return;
    void verify(step.email, code);
  };

  if (
    typeof window !== "undefined" &&
    (window.isSecureContext === false || !globalThis.crypto?.subtle)
  ) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        styal Link sign-in needs HTTPS or localhost. Open this environment over HTTPS, or use
        localhost on the machine running it, then sign in again.
      </p>
    );
  }

  if (step.kind === "email") {
    return (
      <form className="flex flex-col gap-3" onSubmit={submitEmail}>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="relay-sign-in-email">Email</Label>
          <Input
            id="relay-sign-in-email"
            type="email"
            autoComplete="email"
            autoFocus={autoFocus}
            value={email}
            disabled={pending}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Sending code…" : "Send code"}
        </Button>
      </form>
    );
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submitCode}>
      <p className="text-sm text-muted-foreground">
        Enter the code sent to <span className="text-foreground">{step.email}</span>.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="relay-sign-in-code">Code</Label>
        <Input
          id="relay-sign-in-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          value={code}
          disabled={pending}
          onChange={(event) => {
            const next = normalizeSignInCode(event.target.value);
            setCode(next);
            if (next.length === SIGN_IN_CODE_LENGTH && !pending) void verify(step.email, next);
          }}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending || code.length !== SIGN_IN_CODE_LENGTH}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <div className="flex justify-between gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setStep({ kind: "email" });
            setError(null);
          }}
        >
          Use a different email
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending || !canResend}
          onClick={() => void sendCode(step.email)}
        >
          Send a new code
        </Button>
      </div>
    </form>
  );
}
