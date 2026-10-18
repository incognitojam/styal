import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { runtime } from "../../lib/runtime";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import {
  looksLikeEmail,
  normalizeSignInCode,
  relayFailureMessage,
  SIGN_IN_CODE_LENGTH,
} from "./relayEmailSignIn.logic";
import { startEmailSignIn, verifyEmailSignIn } from "./relaySession";

type Step = { readonly kind: "email" } | { readonly kind: "code"; readonly email: string };

/** Email first, then the eight-digit code from the email. */
export function RelayEmailSignInForm(props: { readonly onSignedIn?: () => void }) {
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
      setError(relayFailureMessage(exit));
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
      setError(relayFailureMessage(exit));
      setCode("");
      return;
    }
    props.onSignedIn?.();
  };

  const submitEmail = () => {
    const address = email.trim();
    if (!looksLikeEmail(address)) {
      setError("Enter an email address.");
      return;
    }
    void sendCode(address);
  };

  const errorText = error ? (
    <Text accessibilityRole="alert" className="px-2 text-sm text-danger-foreground">
      {error}
    </Text>
  ) : null;

  if (step.kind === "email") {
    return (
      <View collapsable={false} className="gap-4">
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Sign in to reach your environments through styal Link. We'll email you an eight-digit
          code.
        </Text>
        <ConnectionFormField
          label="Email"
          value={email}
          onChangeText={setEmail}
          editable={!pending}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
          returnKeyType="send"
          onSubmitEditing={submitEmail}
        />
        {errorText}
        <MaterialButton
          label={pending ? "Sending code…" : "Send code"}
          tone="primary"
          fullWidth
          loading={pending}
          onPress={submitEmail}
        />
      </View>
    );
  }

  return (
    <View collapsable={false} className="gap-4">
      <Text className="px-2 text-sm leading-normal text-foreground-muted">
        Enter the code sent to <Text className="text-foreground">{step.email}</Text>.
      </Text>
      <ConnectionFormField
        label="Code"
        value={code}
        onChangeText={(value) => {
          const next = normalizeSignInCode(value);
          setCode(next);
          if (next.length === SIGN_IN_CODE_LENGTH && !pending) void verify(step.email, next);
        }}
        editable={!pending}
        autoFocus
        autoComplete="one-time-code"
        keyboardType="number-pad"
        textContentType="oneTimeCode"
      />
      {errorText}
      <MaterialButton
        label={pending ? "Signing in…" : "Sign in"}
        tone="primary"
        fullWidth
        loading={pending}
        disabled={code.length !== SIGN_IN_CODE_LENGTH}
        onPress={() => void verify(step.email, code)}
      />
      <View className="flex-row flex-wrap justify-between gap-2">
        <MaterialButton
          label="Use a different email"
          tone="text"
          disabled={pending}
          onPress={() => {
            setStep({ kind: "email" });
            setError(null);
          }}
        />
        <MaterialButton
          label="Send a new code"
          tone="text"
          disabled={pending || !canResend}
          onPress={() => void sendCode(step.email)}
        />
      </View>
    </View>
  );
}
