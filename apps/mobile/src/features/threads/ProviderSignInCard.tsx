import { useNavigation } from "@react-navigation/native";
import {
  AuthProvidersManageScope,
  isProviderAuthFailureCode,
  type EnvironmentId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";
import { View } from "react-native";

import { ProviderIcon } from "../../components/ProviderIcon";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentsWithScope } from "../../state/session";
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
  const runtime = thread.runtime;
  if (runtime?.status !== "failed" || !isProviderAuthFailureCode(runtime.lastErrorCode))
    return null;
  const provider = providers
    .get(environmentId)
    ?.find((candidate) => candidate.instanceId === runtime.providerInstanceId);
  if (!provider || !supportsInAppSignIn(provider)) return null;
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
      <Text className="text-xs text-foreground-muted">Sign in, then send your message again.</Text>
      {permitted.has(environmentId) ? (
        <View className="flex-row flex-wrap justify-end gap-2">
          <Button
            label="Sign in"
            tone="primary"
            onPress={() => navigation.navigate("SettingsProviderAccounts")}
          />
        </View>
      ) : null}
    </View>
  );
}
