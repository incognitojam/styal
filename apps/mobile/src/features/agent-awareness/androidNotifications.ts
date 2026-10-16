import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import { Linking, Platform } from "react-native";

export type AndroidAgentChannel = "alerts" | "activity";
export type AndroidAgentChannelStates = Readonly<Record<AndroidAgentChannel, boolean>>;

interface AndroidAgentNotifications {
  configure(deviceId: string, userId: string, scheme: string, ongoingEnabled: boolean): void;
  clear(): void;
  setThreadOnScreen?(path: string | null): void;
  openLiveUpdateSettings?(): boolean;
  createChannels?(): void;
  channelStates?(): AndroidAgentChannelStates | null;
  openChannelSettings?(channel: AndroidAgentChannel): boolean;
  showShowcaseActivity?(scheme: string, data: Record<string, string>): void;
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<AndroidAgentNotifications>("T3AgentNotifications")
    : null;

export function supportsAndroidAgentNotifications(): boolean {
  return typeof native?.configure === "function" && typeof native?.clear === "function";
}

function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme[0] : scheme) ?? "styal";
}

export function configureAndroidAgentNotifications(
  deviceId: string,
  userId: string,
  ongoingEnabled: boolean,
): void {
  native?.configure?.(deviceId, userId, appScheme(), ongoingEnabled);
}

export function showAndroidShowcaseAgentActivity(data: Record<string, string>): boolean {
  if (!native?.showShowcaseActivity) return false;
  native.showShowcaseActivity(appScheme(), data);
  return true;
}

export function clearAndroidAgentNotifications(): void {
  native?.clear?.();
}

export function setAndroidThreadOnScreen(path: string | null): void {
  native?.setThreadOnScreen?.(path);
}

export function supportsAndroidLiveUpdateSettings(): boolean {
  return Platform.OS === "android" && Number(Platform.Version) >= 36;
}

export async function openAndroidLiveUpdateSettings(): Promise<void> {
  if (!native?.openLiveUpdateSettings?.()) {
    await Linking.openSettings();
  }
}

/** Creates the alert and activity channels; false when the installed binary predates it. */
export function createAndroidAgentChannels(): boolean {
  if (!native?.createChannels) return false;
  native.createChannels();
  return true;
}

/** Which channels Android lets post, or null when the binary cannot tell. */
export function getAndroidAgentChannelStates(): AndroidAgentChannelStates | null {
  return native?.channelStates?.() ?? null;
}

export async function openAndroidAgentChannelSettings(channel: AndroidAgentChannel): Promise<void> {
  if (!native?.openChannelSettings?.(channel)) {
    await Linking.openSettings();
  }
}
