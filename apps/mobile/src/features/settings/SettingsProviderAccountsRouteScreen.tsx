import * as Dialog from "../../components/ui/Dialog";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  isManagedDriverAllowed,
  type ProviderAuthResponse,
  type ServerProvider,
} from "@t3tools/contracts";
import { applyMaskedEdit, maskCode } from "@t3tools/shared/maskedCode";
import { redactedPlaceholder } from "@t3tools/shared/redactedText";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";
import { BlurView } from "expo-blur";
import * as Clipboard from "expo-clipboard";
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { MenuAction } from "@react-native-menu/menu";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { AppText as Text } from "../../components/ui/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { reportForkClientUsage } from "../../state/forkClientUsage";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "./appearance/AppearancePreferencesProvider";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  externalSignInStatus,
  providerUnavailableReason,
  sortProvidersForAccounts,
  supportsInAppSignIn,
} from "./providerAccountStatus";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

export function SettingsProviderAccountsRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const permittedEnvironments = useEnvironmentsWithScope(selectedTargets, AuthProvidersManageScope);
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  const insets = useSafeAreaInsets();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Providers" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {selectedTargets.length === 0 ? (
            <Text className="text-foreground-muted">Select a connected environment.</Text>
          ) : (
            selectedTargets.map((environment) => (
              <SettingsSection key={environment.environmentId} title={environment.label}>
                {!permittedEnvironments.has(environment.environmentId) ? (
                  <View className="gap-1 p-4">
                    <Text className="text-base text-foreground">Limited permissions</Text>
                    <Text className="text-sm text-foreground-muted">
                      {`This session can view ${environment.label}'s providers but can't change their settings.`}
                    </Text>
                  </View>
                ) : (
                  <>
                    {sortProvidersForAccounts(
                      managedProviders(environment, providersByEnvironment),
                    ).map((provider, index) =>
                      supportsInAppSignIn(provider) ? (
                        <ProviderAccount
                          key={provider.instanceId}
                          environment={environment}
                          divider={index > 0}
                          provider={provider}
                        />
                      ) : (
                        <ExternalProviderAccount
                          key={provider.instanceId}
                          provider={provider}
                          divider={index > 0}
                        />
                      ),
                    )}
                    {managedProviders(environment, providersByEnvironment).length === 0 ? (
                      <Text className="p-4 text-foreground-muted">
                        Add a provider in web or desktop Settings.
                      </Text>
                    ) : null}
                  </>
                )}
              </SettingsSection>
            ))
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

/** Providers the environment's managed policy allows; the rest cannot run or sign in. */
function managedProviders(
  environment: SettingsTarget,
  providersByEnvironment: ReadonlyMap<string, ReadonlyArray<ServerProvider>>,
) {
  return (providersByEnvironment.get(environment.environmentId) ?? []).filter((provider) =>
    isManagedDriverAllowed(environment.serverConfig.managedPolicy, provider.driver),
  );
}

function ExternalProviderAccount({
  provider,
  divider,
}: {
  readonly provider: ServerProvider;
  readonly divider: boolean;
}) {
  const email =
    provider.auth.status === "authenticated" && !providerUnavailableReason(provider)
      ? provider.auth.email?.trim()
      : undefined;
  return (
    <View className={divider ? "border-t border-border-subtle" : undefined}>
      <View className="min-h-16 flex-row items-center gap-3 px-4 py-3">
        <ProviderIcon provider={provider.driver} iconUrl={provider.iconUrl} size={20} />
        <ProviderAccountSummary
          key={email}
          name={provider.displayName ?? provider.driver}
          status={externalSignInStatus(provider)}
          email={email}
        />
      </View>
    </View>
  );
}

function ProviderAccountSummary({
  name,
  status,
  email,
}: {
  readonly name: string;
  readonly status: string | null | undefined;
  readonly email: string | undefined;
}) {
  return (
    <View className="min-w-0 shrink grow gap-0.5">
      <Text textRole="body" className="text-foreground">
        {name}
      </Text>
      <Text accessibilityLiveRegion="polite" textRole="footnote" className="text-foreground-muted">
        {status}
      </Text>
      {email ? <ProviderAccountEmail key={email} email={email} /> : null}
    </View>
  );
}

function ProviderAccount({
  environment,
  provider,
  divider,
}: {
  readonly environment: SettingsTarget;
  readonly provider: ServerProvider;
  readonly divider: boolean;
}) {
  const environmentId = environment.environmentId;
  const instanceId = provider.instanceId;
  const target = { environmentId, input: { instanceId } };
  const auth = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const options = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderAuth, options);
  const respond = useAtomCommand(serverEnvironment.respondProviderAuth, options);
  const complete = useAtomCommand(serverEnvironment.completeProviderAuth, options);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, options);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, options);
  // Matches ListRowLayout: large text stacks the action below instead of squeezing the status.
  const stacked = useWindowDimensions().fontScale >= 1.5;
  const [pending, setPending] = useState(false);
  const [revealedFlowId, setRevealedFlowId] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ id: "", values: {} as Record<string, string> });
  const state = auth.data;
  const interaction = state?.interaction;
  const draftId = `${state?.flowId ?? ""}:${interaction?.id ?? ""}`;
  const values = draft.id === draftId ? draft.values : {};
  const active =
    state?.phase === "starting" || state?.phase === "waiting" || state?.phase === "verifying";
  const signedIn =
    provider.auth.status === "authenticated" ||
    (provider.auth.status === "unknown" && state?.phase === "succeeded");
  const isDiscovering =
    provider.driver === "acpRegistry" &&
    !active &&
    !signedIn &&
    !auth.error &&
    state?.methods === undefined;
  const needsExternalSetup =
    !active &&
    !signedIn &&
    (provider.setup?.canAuthenticate === false ||
      (provider.driver === "acpRegistry" && state?.methods?.length === 0));
  const url =
    interaction?.type === "browser" || interaction?.type === "deviceCode"
      ? interaction.url
      : state?.authorizationUrl;
  const unavailable = providerUnavailableReason(provider);
  const disabled = pending || auth.error !== null || isDiscovering;
  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const result = await command();
    pendingRef.current = false;
    setPending(false);
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not update provider sign-in.");
    }
    return false;
  }
  function send(response: ProviderAuthResponse) {
    if (!state?.flowId || !interaction) return Promise.resolve(false);
    return run(() =>
      respond({
        environmentId,
        input: { instanceId, flowId: state.flowId!, interactionId: interaction.id, response },
      }),
    );
  }
  function field(name: string, label: string, secret: boolean) {
    return (
      <TextInput
        accessibilityLabel={label}
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
        placeholderTextColorClassName="accent-foreground-muted"
        placeholder={label}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!disabled}
        maxLength={secret && interaction?.type === "terminal" ? 4_095 : 16_384}
        value={values[name] ?? ""}
        onChangeText={(value) => setDraft({ id: draftId, values: { ...values, [name]: value } })}
      />
    );
  }
  function codeField(name: string, label: string) {
    return (
      <TextInput
        accessibilityLabel={label}
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
        placeholderTextColorClassName="accent-foreground-muted"
        placeholder={label}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        textContentType="none"
        importantForAutofill="no"
        spellCheck={false}
        editable={!disabled}
        maxLength={16_384}
        value={maskCode(values[name] ?? "")}
        onChangeText={(masked) =>
          setDraft({
            id: draftId,
            values: { ...values, [name]: applyMaskedEdit(values[name] ?? "", masked) },
          })
        }
      />
    );
  }
  const name = provider.displayName ?? provider.driver;
  const email =
    signedIn && !active && !providerUnavailableReason(provider)
      ? provider.auth.email?.trim()
      : undefined;
  const methods = state?.methods ?? [];
  const usesCliLogin = methods.length === 1 && methods[0]?.id === "cli";
  // The status line says why a provider that is missing or turned off can't sign in.
  const canSignIn =
    !active &&
    !needsExternalSetup &&
    provider.setup?.canAuthenticate !== false &&
    provider.enabled &&
    provider.installed;
  const signInDisabled = disabled || state === null;
  const canSignOut =
    !active && signedIn && (provider.auth.canLogout ?? provider.setup?.canAuthenticate);
  const showCallback =
    Boolean(url) && (interaction?.type === "browser" ? interaction.acceptsCallback : !interaction);
  const usesCredentials =
    provider.driver === "antigravity" &&
    (provider.auth.type === "gemini-api-key" || provider.auth.type === "agent-platform");

  // A CLI login's answer only exists after its page has been opened, here or on another device.
  const answerWaitsForLink =
    usesCliLogin && (interaction?.id === "code-0" || interaction?.id === "browser");
  const answerRevealed = !answerWaitsForLink || revealedFlowId === state?.flowId;
  const status =
    active || state?.phase === "failed" || state?.phase === "cancelled"
      ? state.message
      : unavailable
        ? unavailable
        : signedIn
          ? "Signed in"
          : isDiscovering
            ? "Discovering sign-in methods…"
            : needsExternalSetup
              ? "No in-app sign-in advertised. Follow the provider's docs to finish setup."
              : usesCredentials
                ? "Connect to load models"
                : "Not signed in";
  // A provider with several sign-in methods picks one from a menu on the same control.
  const methodActions: MenuAction[] = methods.map((method) => ({
    id: `method:${method.id}`,
    title: method.name,
  }));
  function startSignIn(methodId?: string) {
    if (usesCliLogin) {
      void reportForkClientUsage(environmentId, {
        feature: "provider-sign-in",
        action: "start",
        entryPoint: "settings",
      });
    }
    void run(() => start(methodId ? { environmentId, input: { instanceId, methodId } } : target));
  }
  function signOut() {
    Dialog.alert(
      "Sign out?",
      `Running threads sharing this sign-in on ${environment.label} will stop. Thread history is kept.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => {
            void run(() => logout(target));
          },
        },
      ],
    );
  }
  function onMenuAction(id: string) {
    if (id === "signOut") signOut();
    // iOS keeps a disabled submenu's children selectable, so sign-in guards here too.
    else if (signInDisabled) return;
    else if (id.startsWith("method:")) startSignIn(id.slice("method:".length));
    else if (id === "change") startSignIn();
  }
  const accountActions: MenuAction[] = [
    ...(canSignIn
      ? [
          {
            id: "change",
            title: usesCliLogin ? "Sign in again" : "Change account",
            image: "person.crop.circle",
            attributes: { disabled: signInDisabled },
            ...(methodActions.length > 1
              ? {
                  subactions: methodActions.map((action) => ({
                    ...action,
                    attributes: { disabled: signInDisabled },
                  })),
                }
              : {}),
          },
        ]
      : []),
    ...(canSignOut
      ? [
          {
            id: "signOut",
            title: "Sign out",
            image: "rectangle.portrait.and.arrow.right",
            attributes: { destructive: true, disabled: disabled || state === null },
          },
        ]
      : []),
  ];
  const trailing = pending ? (
    <View className="h-11 w-11 items-center justify-center">
      <AppActivityIndicator colorClassName="accent-icon" />
    </View>
  ) : !providerUnavailableReason(provider) &&
    needsExternalSetup &&
    provider.setup?.documentationUrl ? (
    <ControlPill
      variant="pill"
      label="Docs"
      onPress={() => {
        void Linking.openURL(provider.setup!.documentationUrl!).catch(() =>
          setError("Could not open the provider docs."),
        );
      }}
    />
  ) : active && state?.flowId ? (
    <ControlPill
      variant="pill"
      label="Cancel sign-in"
      accessibilityLabel={`Cancel ${name} sign-in`}
      disabled={disabled}
      onPress={() => {
        void run(() => cancel({ environmentId, input: { instanceId, flowId: state.flowId! } }));
      }}
    />
  ) : signedIn && !active && accountActions.length > 0 ? (
    <Menu
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${name} account options`}
      title={name}
      actions={accountActions}
      onPressAction={({ nativeEvent }) => onMenuAction(nativeEvent.event)}
    >
      <ControlPill icon="ellipsis" accessibilityLabel={`${name} account options`} />
    </Menu>
  ) : canSignIn && !signedIn && methodActions.length > 1 && !signInDisabled ? (
    <Menu
      accessible
      accessibilityRole="button"
      accessibilityLabel={`Sign in to ${name}`}
      title="Sign in with"
      actions={methodActions}
      onPressAction={({ nativeEvent }) => onMenuAction(nativeEvent.event)}
    >
      <ControlPill variant="primary" label="Sign in" accessibilityLabel={`Sign in to ${name}`} />
    </Menu>
  ) : canSignIn && !signedIn ? (
    <ControlPill
      variant="primary"
      label={usesCredentials ? "Connect" : "Sign in"}
      accessibilityLabel={usesCredentials ? `Connect to ${name}` : `Sign in to ${name}`}
      disabled={signInDisabled}
      onPress={() => startSignIn()}
    />
  ) : null;
  return (
    <View className={divider ? "border-t border-border-subtle" : undefined}>
      <View
        className={
          stacked
            ? "min-h-16 items-start gap-3 px-4 py-3"
            : "min-h-16 flex-row items-center gap-3 px-4 py-3"
        }
      >
        <View className="min-w-0 shrink grow flex-row items-center gap-3">
          <ProviderIcon provider={provider.driver} iconUrl={provider.iconUrl} size={20} />
          <ProviderAccountSummary key={email} name={name} status={status} email={email} />
        </View>
        {trailing}
      </View>
      {url ? (
        <SettingsActionRow
          icon="globe"
          label="Open sign-in page"
          disabled={disabled}
          onPress={() => {
            setRevealedFlowId(state?.flowId ?? null);
            void (async () => {
              if (
                interaction?.type === "browser" &&
                interaction.requiresConsent &&
                !(await send({ type: "browser", action: "accept" }))
              )
                return;
              await Linking.openURL(url);
            })().catch(() => setError("Could not open the sign-in page."));
          }}
        />
      ) : null}
      {url && usesCliLogin ? (
        <SettingsActionRow
          icon="doc.on.doc"
          label="Copy sign-in link"
          disabled={disabled}
          onPress={() => {
            setRevealedFlowId(state?.flowId ?? null);
            void Clipboard.setStringAsync(url).catch(() =>
              setError("Could not copy the sign-in link."),
            );
          }}
        />
      ) : null}
      {interaction?.type === "deviceCode" ||
      interaction?.type === "terminal" ||
      (answerRevealed && (interaction?.type === "credentials" || showCallback)) ||
      error ||
      auth.error ? (
        <View className="gap-2 px-4 pb-3">
          {interaction?.type === "deviceCode" ? (
            <Text selectable className="text-foreground">
              Enter code {interaction.userCode} on the sign-in page.
            </Text>
          ) : null}
          {interaction?.type === "terminal" ? (
            <>
              <ScrollView className="max-h-64" nestedScrollEnabled>
                <Text selectable className="font-mono text-sm text-foreground">
                  {interaction.output.replace(
                    /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g,
                    "",
                  )}
                </Text>
              </ScrollView>
              <View className="flex-row flex-wrap gap-2">
                {TERMINAL_KEYS.map((key) => (
                  <ControlPill
                    key={key.label}
                    variant="pill"
                    label={key.label}
                    accessibilityLabel={key.accessibilityLabel}
                    disabled={disabled}
                    onPress={() => void send({ type: "terminal", data: key.data })}
                  />
                ))}
              </View>
              {field("input", "Terminal response", true)}
              <SettingsActionRow
                icon="arrow.up"
                label="Send response"
                disabled={disabled}
                onPress={() => {
                  void send({ type: "terminal", data: `${values.input ?? ""}\r` }).then((sent) => {
                    if (sent) setDraft({ id: "", values: {} });
                  });
                }}
              />
            </>
          ) : null}
          {interaction?.type === "credentials" && answerRevealed ? (
            <>
              {interaction.fields.map((entry) => (
                <View key={entry.name}>
                  {entry.secret && interaction.url
                    ? codeField(entry.name, entry.label)
                    : field(entry.name, entry.label, entry.secret)}
                </View>
              ))}
              <SettingsActionRow
                icon="person.crop.circle"
                label={interaction.url ? "Continue" : "Connect"}
                disabled={disabled || !Object.values(values).some((value) => value.trim())}
                onPress={() => {
                  void send({ type: "credentials", values }).then((sent) => {
                    if (sent) setDraft({ id: "", values: {} });
                  });
                }}
              />
            </>
          ) : null}
          {showCallback && answerRevealed ? (
            <>
              {field("callback", "Final localhost URL", false)}
              <SettingsActionRow
                icon="arrow.right"
                label="Continue"
                disabled={disabled || !values.callback?.trim()}
                onPress={() => {
                  if (!state?.flowId) return;
                  void run(() =>
                    complete({
                      environmentId,
                      input: { instanceId, flowId: state.flowId!, callbackUrl: values.callback! },
                    }),
                  ).then((sent) => {
                    if (sent) setDraft({ id: "", values: {} });
                  });
                }}
              />
            </>
          ) : null}
          {error || auth.error ? (
            <Text accessibilityRole="alert" className="text-danger-foreground">
              {error ?? auth.error}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The account email, shown as a blurred same-shaped placeholder until tapped.
 * Android blurs the text with a view filter; iOS has no blur filter, so a
 * static BlurView covers it instead.
 */
function ProviderAccountEmail({ email }: { readonly email: string }) {
  const [revealed, setRevealed] = useState(false);
  const { themeAppearance } = useAppearancePreferences();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={revealed ? "Hide account email" : "Reveal account email"}
      hitSlop={12}
      onPress={() => setRevealed((value) => !value)}
      className="self-start"
    >
      <Text
        className="text-xs text-foreground-muted ios:font-[family-name:Menlo] android:font-mono"
        style={!revealed && Platform.OS === "android" ? EMAIL_BLUR_FILTER : undefined}
      >
        {revealed ? email : redactedPlaceholder(email)}
      </Text>
      {!revealed && Platform.OS === "ios" ? (
        <BlurView
          pointerEvents="none"
          intensity={12}
          tint={themeAppearance === "dark" ? "dark" : "light"}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
    </Pressable>
  );
}

const EMAIL_BLUR_FILTER = { filter: [{ blur: 3 }] };

// A login's menus take arrow keys, which a phone keyboard cannot type.
const TERMINAL_KEYS = [
  { label: "↑", accessibilityLabel: "Up arrow", data: "\x1b[A" },
  { label: "↓", accessibilityLabel: "Down arrow", data: "\x1b[B" },
  { label: "Enter", accessibilityLabel: "Enter", data: "\r" },
];
