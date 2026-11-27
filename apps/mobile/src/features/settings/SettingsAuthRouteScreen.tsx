import { useGT, msg } from "gt-react-native";
import { m } from "../../i18n/messages";
import { useNavigation } from "@react-navigation/native";
import type { ManagedRelaySession } from "@t3tools/client-runtime/relay-session";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { runtime } from "../../lib/runtime";
import { refreshManagedRelayEnvironments } from "../cloud/managedRelayState";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { RelayEmailSignInForm } from "../cloud/RelayEmailSignInForm";
import { RelayLinkedServersSection } from "../cloud/RelayLinkedServersSection";
import { deleteRelayAccount, signOutOfRelay } from "../cloud/relaySession";
import { relayFailureMessage } from "../cloud/relayEmailSignIn.logic";
import { RelaySignedInDevicesSection } from "../cloud/RelaySignedInDevicesSection";
import { useRelayAuth } from "../cloud/useRelayAuth";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

// Without cloud config the app has no entry point here and appLinking drops the deep link.
export function SettingsAuthRouteScreen() {
  return hasCloudPublicConfig() ? <ConfiguredSettingsAuthRouteScreen /> : null;
}

function ConfiguredSettingsAuthRouteScreen() {
  const gt = useGT();
  const { isLoaded, session } = useRelayAuth();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const wasSignedIn = useRef(false);

  // Signing out here, or the session ending elsewhere, returns to Settings.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pops the navigator when the session ends here or elsewhere
  useEffect(() => {
    if (session !== null) {
      wasSignedIn.current = true;
    } else if (wasSignedIn.current && isLoaded) {
      navigation.goBack();
    }
  }, [isLoaded, navigation, session]);

  return (
    <SettingsScreen title={gt("styal Account")}>
      {session !== null ? (
        <RelayAccountContent session={session} />
      ) : (
        <ScreenScrollView
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1"
          contentContainerClassName="gap-4 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {isLoaded ? (
            <RelayEmailSignInForm />
          ) : (
            <View className="items-center pt-6">
              <AppActivityIndicator colorClassName="accent-icon" />
            </View>
          )}
        </ScreenScrollView>
      )}
    </SettingsScreen>
  );
}

function confirmSignOut(onConfirm: () => void) {
  const title = m(msg("Sign out of styal Link?"));
  const message = m(
    msg(
      "This device stops receiving agent notifications, and styal Link environments are removed from it. Your account and servers are not changed.",
    ),
  );
  Dialog.confirm({ title, message, confirmText: m(msg("Sign out")), destructive: true, onConfirm });
}

function confirmDeleteAccount(email: string | null, onConfirm: () => void) {
  const title = m(msg("Delete your styal Link account?"));
  const message = email
    ? m(
        msg(
          "{email} will be deleted. Every environment is unlinked and loses its styal Link address, mobile devices stop getting notifications, and every device is signed out. This cannot be undone.",
        ),
        { email },
      )
    : m(
        msg(
          "Every environment is unlinked and loses its styal Link address, mobile devices stop getting notifications, and every device is signed out. This cannot be undone.",
        ),
      );
  Dialog.confirm({
    title,
    message,
    confirmText: m(msg("Delete account")),
    destructive: true,
    onConfirm,
  });
}

function RelayAccountContent(props: { readonly session: ManagedRelaySession }) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const [signingOut, setSigningOut] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    setRefreshKey((key) => key + 1);
    refreshManagedRelayEnvironments();
  }, []);

  const signOut = () => {
    setSigningOut(true);
    void runtime.runPromiseExit(signOutOfRelay).then((exit) => {
      setSigningOut(false);
      if (exit._tag === "Failure") Dialog.alert(gt("Sign out"), relayFailureMessage(exit));
    });
  };

  const [deleting, setDeleting] = useState(false);
  const deleteAccount = () => {
    setDeleting(true);
    void runtime.runPromiseExit(deleteRelayAccount).then((exit) => {
      setDeleting(false);
      if (exit._tag === "Failure") {
        Dialog.alert(
          gt("Could not delete the account"),
          gt("Check your connection and try again."),
        );
      }
    });
  };

  return (
    <ScreenScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1"
      contentContainerClassName="gap-4 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}
    >
      <SettingsSection title={gt("Account")}>
        <ListRowLayout
          icon="person.crop.circle"
          label={props.session.email ?? gt("Signed in")}
          description={gt("styal Link account")}
        />
      </SettingsSection>
      <RelaySignedInDevicesSection key={refreshKey} session={props.session} />
      <RelayLinkedServersSection />
      <SettingsSection>
        <SettingsActionRow
          icon="rectangle.portrait.and.arrow.right"
          label={gt("Sign out")}
          tone="danger"
          loading={signingOut}
          disabled={signingOut || deleting}
          onPress={() => confirmSignOut(signOut)}
        />
        <SettingsActionRow
          icon="trash"
          label={gt("Delete account")}
          tone="danger"
          loading={deleting}
          disabled={deleting || signingOut}
          onPress={() => confirmDeleteAccount(props.session.email, deleteAccount)}
        />
      </SettingsSection>
    </ScreenScrollView>
  );
}
