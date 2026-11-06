import { useNavigation } from "@react-navigation/native";
import {
  AuthProvidersManageScope,
  isProviderAuthFailureCode,
  type EnvironmentId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { ProviderIcon } from "../../components/ProviderIcon";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentsWithScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { supportsInAppSignIn } from "../settings/providerAccountStatus";

/** Offers the provider's sign-in where a thread failed because that provider is signed out. */
export function ProviderSignInCard({
  thread,
  environmentId,
}: {
  thread: EnvironmentThreadShell;
  environmentId: EnvironmentId;
}) {
  const navigation = useNavigation();
  const providers = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  const targets = useMemo(() => [{ environmentId }], [environmentId]);
  const permitted = useEnvironmentsWithScope(targets, AuthProvidersManageScope);
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runtime = thread.runtime;
  if (runtime?.status !== "failed" || !isProviderAuthFailureCode(runtime.lastErrorCode))
    return null;
  const provider = providers
    .get(environmentId)
    ?.find((candidate) => candidate.instanceId === runtime.providerInstanceId);
  if (!provider || !supportsInAppSignIn(provider)) return null;
  const runId = thread.latestRun?.runId;
  const recovery = thread.authRecovery?.runId === runId ? thread.authRecovery : null;
  const waiting = recovery?.waiting === true;
  async function setWaiting(next: boolean) {
    if (!runId) return;
    setPending(true);
    setError(null);
    const result = await updateMetadata({
      environmentId,
      input: { threadId: thread.id, authRecovery: { runId, waiting: next } },
    });
    setPending(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not change this thread.");
    }
  }
  return (
    <View
      accessibilityRole="alert"
      className="mx-3 mb-2 gap-2 rounded-xl border border-border-subtle bg-screen p-3"
    >
      <View className="flex-row items-center gap-2">
        <ProviderIcon provider={provider.driver} iconUrl={provider.iconUrl} size={16} />
        <Text className="min-w-0 flex-1 text-sm font-t3-medium text-foreground">
          {`${provider.displayName ?? provider.driver} needs you to sign in`}
        </Text>
      </View>
      <Text className="text-xs text-foreground-muted">
        {waiting ? "It continues after you sign in." : "Sign in, then send your message again."}
      </Text>
      <View className="flex-row flex-wrap justify-end gap-2">
        {recovery ? (
          <Button
            label={waiting ? "Stop waiting" : "Continue after sign-in"}
            tone="secondary"
            disabled={pending}
            onPress={() => void setWaiting(!waiting)}
          />
        ) : null}
        {permitted.has(environmentId) ? (
          <Button
            label="Sign in"
            tone="primary"
            onPress={() => navigation.navigate("SettingsProviderAccounts")}
          />
        ) : null}
      </View>
      {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
    </View>
  );
}
