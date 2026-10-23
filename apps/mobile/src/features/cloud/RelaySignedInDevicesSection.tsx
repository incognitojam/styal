import { ManagedRelay, type ManagedRelaySession } from "@t3tools/client-runtime/relay";
import type { RelayAccountSessionRecord } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useState } from "react";
import { Platform, View } from "react-native";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { runtime } from "../../lib/runtime";
import { SettingsSection } from "../settings/components/SettingsSection";
import { relayFailureMessage } from "./relayEmailSignIn.logic";

const CLIENT_LABELS: Record<RelayAccountSessionRecord["clientId"], string> = {
  "t3-web": "Web or desktop",
  "t3-mobile": "Mobile",
  "t3-cli": "Command line",
};

const CLIENT_ICONS: Record<RelayAccountSessionRecord["clientId"], AppSymbolName> = {
  "t3-web": "desktopcomputer",
  "t3-mobile": { ios: "iphone", android: "smartphone" },
  "t3-cli": "terminal",
};

const lastUsedFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function lastUsedLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : lastUsedFormatter.format(date);
}

/**
 * Every place the account is signed in to styal Link. Signing one out ends
 * its session there; this device signs out with the Sign out row instead.
 */
export function RelaySignedInDevicesSection(props: { readonly session: ManagedRelaySession }) {
  const { session } = props;
  const [sessions, setSessions] = useState<ReadonlyArray<RelayAccountSessionRecord> | null>(null);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const exit = await runtime.runPromiseExit(
      ManagedRelay.ManagedRelayClient.pipe(
        Effect.flatMap((client) => client.listSessions({ credential: session.credential })),
      ),
    );
    if (exit._tag === "Failure") {
      setError(relayFailureMessage(exit));
      return;
    }
    setError(null);
    setSessions(exit.value);
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (sessionId: string) => {
    setPendingSessionId(sessionId);
    const exit = await runtime.runPromiseExit(
      ManagedRelay.ManagedRelayClient.pipe(
        Effect.flatMap((client) =>
          client.revokeSession({ credential: session.credential, sessionId }),
        ),
      ),
    );
    setPendingSessionId(null);
    if (exit._tag === "Failure") {
      setError(relayFailureMessage(exit));
      return;
    }
    await load();
  };

  return (
    <View className="gap-2">
      <SettingsSection title="Signed-in devices">
        {sessions === null && error === null ? (
          <View className="flex-row items-center gap-3 p-4">
            <AppActivityIndicator colorClassName="accent-icon" size="small" />
            <Text className="text-base text-foreground-muted">Loading devices</Text>
          </View>
        ) : null}
        {(sessions ?? []).map((entry) => (
          <View
            key={entry.sessionId}
            collapsable={false}
            className="flex-row items-center gap-4 p-4"
          >
            <SymbolView
              name={CLIENT_ICONS[entry.clientId]}
              size={Platform.OS === "android" ? 24 : 22}
              tintColorClassName="accent-icon"
              type="monochrome"
              weight="regular"
            />
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-lg text-foreground android:text-base" numberOfLines={1}>
                {entry.label ?? CLIENT_LABELS[entry.clientId]}
              </Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                {entry.current
                  ? "This device"
                  : `${CLIENT_LABELS[entry.clientId]} · last used ${lastUsedLabel(entry.lastUsedAt)}`}
              </Text>
            </View>
            {entry.current ? null : (
              <MaterialButton
                label="Sign out"
                tone="text"
                loading={pendingSessionId === entry.sessionId}
                disabled={pendingSessionId !== null}
                onPress={() => void revoke(entry.sessionId)}
              />
            )}
          </View>
        ))}
      </SettingsSection>
      {error ? (
        <Text accessibilityRole="alert" className="px-2 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
