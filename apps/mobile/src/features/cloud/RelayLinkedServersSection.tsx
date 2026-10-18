import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { type ReactNode, useRef, useState } from "react";
import { Alert, Platform, Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { ControlPillMenu } from "../../components/ControlPill";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  deregisterManagedRelayEnvironmentCommand,
  useManagedRelayEnvironments,
} from "./managedRelayState";

const linkedAtFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function linkedAtLabel(value: string): string {
  const linkedAt = new Date(value);
  return Number.isNaN(linkedAt.getTime())
    ? "Link date unavailable"
    : `Linked ${linkedAtFormatter.format(linkedAt)}`;
}

function endpointLabel(environment: RelayClientEnvironmentRecord): string {
  return environment.endpoint.providerKind === "cloudflare_tunnel"
    ? "Managed tunnel"
    : "Activity publishing only";
}

function confirmDeregister(environment: RelayClientEnvironmentRecord, onConfirm: () => void) {
  const title = "Deregister server?";
  const message = `“${environment.label}” will be removed from this account. styal Link access will be revoked, any managed tunnel will be removed, and a host space will become available. Local connections on your devices are not changed.`;
  if (process.env.EXPO_OS === "ios") {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Deregister", style: "destructive", onPress: onConfirm },
    ]);
    return;
  }
  showConfirmDialog({ title, message, confirmText: "Deregister", destructive: true, onConfirm });
}

/**
 * Every server registered to the signed-in styal Link account, with
 * account-level deregistration. Connections on this device are managed in
 * Settings instead.
 */
export function RelayLinkedServersSection() {
  const environmentsState = useManagedRelayEnvironments();
  const deregisterEnvironment = useAtomCommand(deregisterManagedRelayEnvironmentCommand, {
    reportFailure: false,
  });
  const [deregisteringEnvironmentId, setDeregisteringEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const mutationPendingRef = useRef(false);
  // Deregistered rows stay in the cached list until the refresh lands, so hide
  // them by the linkedAt they had. A re-link produces a new linkedAt and shows again.
  const [removedEnvironments, setRemovedEnvironments] = useState<{
    readonly accountId: string | null;
    readonly linkedAtById: ReadonlyMap<EnvironmentId, string>;
  }>({ accountId: null, linkedAtById: new Map() });

  const handleDeregister = async (environment: RelayClientEnvironmentRecord) => {
    const accountId = environmentsState.accountId;
    if (!accountId || mutationPendingRef.current) return;

    mutationPendingRef.current = true;
    setDeregisteringEnvironmentId(environment.environmentId);
    const result = await deregisterEnvironment({
      accountId,
      environmentId: environment.environmentId,
    });
    mutationPendingRef.current = false;
    setDeregisteringEnvironmentId(null);

    if (result._tag === "Success") {
      setRemovedEnvironments((current) => {
        const linkedAtById = new Map(current.accountId === accountId ? current.linkedAtById : []);
        linkedAtById.set(environment.environmentId, environment.linkedAt);
        return { accountId, linkedAtById };
      });
      environmentsState.refresh();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;

    const cause = squashAtomCommandFailure(result);
    const message = cause instanceof Error ? cause.message : "Could not deregister the server.";
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not deregister environment", {
      environmentId: environment.environmentId,
      message,
      traceId,
      cause,
    });
    Alert.alert(
      "Could not deregister server",
      traceId ? `${message}\n\nTrace ID: ${traceId}` : message,
      traceId
        ? [
            {
              text: "Copy trace ID",
              onPress: () => copyTextWithHaptic(traceId, { target: "connection-trace-id" }),
            },
            { text: "OK", style: "cancel" },
          ]
        : undefined,
    );
  };

  const removedEnvironmentLinkedAt =
    removedEnvironments.accountId === environmentsState.accountId
      ? removedEnvironments.linkedAtById
      : new Map<EnvironmentId, string>();
  const environments = (environmentsState.data ?? []).filter(
    (environment) =>
      removedEnvironmentLinkedAt.get(environment.environmentId) !== environment.linkedAt,
  );
  const isInitialLoad =
    !environmentsState.accountId || (environmentsState.data === null && !environmentsState.error);
  const errorTraceId = environmentsState.errorTraceId;

  return (
    <>
      <SettingsSection title="Registered servers">
        {environmentsState.error ? (
          <>
            <ServerRow
              title="Could not load styal Link environments"
              subtitle={environmentsState.error}
            />
            {errorTraceId ? (
              <SettingsActionRow
                icon="doc.on.doc"
                label="Copy trace ID"
                onPress={() => {
                  copyTextWithHaptic(errorTraceId, { target: "connection-trace-id" });
                }}
              />
            ) : null}
          </>
        ) : isInitialLoad ? (
          <View className="flex-row items-center gap-3 p-4">
            <AppActivityIndicator colorClassName="accent-icon" size="small" />
            <Text className="text-base text-foreground-muted">Loading environments</Text>
          </View>
        ) : environments.length > 0 ? (
          environments.map((environment) => (
            <ServerRow
              key={environment.environmentId}
              title={environment.label}
              subtitle={`${linkedAtLabel(environment.linkedAt)} · ${endpointLabel(environment)}`}
              accessory={
                deregisteringEnvironmentId === environment.environmentId ? (
                  <AppActivityIndicator colorClassName="accent-icon" size="small" />
                ) : (
                  <ControlPillMenu
                    actions={ENVIRONMENT_MENU_ACTIONS}
                    isAnchoredToRight
                    onPressAction={() =>
                      confirmDeregister(environment, () => void handleDeregister(environment))
                    }
                  >
                    <Pressable
                      accessibilityLabel={`Actions for ${environment.label}`}
                      accessibilityRole="button"
                      disabled={deregisteringEnvironmentId !== null}
                      className="size-[30px] items-center justify-center active:opacity-60 disabled:opacity-50"
                    >
                      <View className="rotate-90">
                        <SymbolView
                          name="ellipsis"
                          size={18}
                          tintColorClassName="accent-icon"
                          type="monochrome"
                        />
                      </View>
                    </Pressable>
                  </ControlPillMenu>
                )
              }
            />
          ))
        ) : (
          <ServerRow
            title="No servers registered"
            subtitle="Link a server from its local Settings to reach it through styal Link."
          />
        )}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Connections on this device are managed in Settings.
      </Text>
    </>
  );
}

const ENVIRONMENT_MENU_ACTIONS = [
  { id: "deregister", title: "Deregister", image: "trash", attributes: { destructive: true } },
] satisfies MenuAction[];

function ServerRow(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly accessory?: ReactNode;
}) {
  return (
    <View collapsable={false} className="flex-row items-center gap-4 p-4">
      <SymbolView
        name="server.rack"
        size={Platform.OS === "android" ? 24 : 22}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="regular"
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-lg text-foreground android:text-base" numberOfLines={1}>
          {props.title}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={2}>
          {props.subtitle}
        </Text>
      </View>
      {props.accessory}
    </View>
  );
}
