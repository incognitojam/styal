import { type LiveActivity } from "expo-widgets";
import {
  configureAndroidAgentNotifications,
  clearAndroidAgentNotifications,
} from "./androidNotifications";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { AppState, Platform } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  type RelayDeviceRegistrationRequest,
  type RelayAgentActivitySnapshotResponse,
  type RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  isAtomCommandInterrupted,
  settleAsyncResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import type { Preferences } from "../../persistence/mobile-preferences";
import {
  clearAgentAwarenessRegistrationRecord,
  loadAgentAwarenessDeviceId,
  loadAgentAwarenessRegistrationRecord,
  loadOrCreateAgentAwarenessDeviceId,
  loadPreferences,
  saveAgentAwarenessRegistrationRecord,
} from "../../persistence/imperative";
import type { AgentActivityProps } from "../../widgets/AgentActivity";
import {
  dismissEndedAgentLiveActivities,
  getAgentLiveActivities,
  startAgentLiveActivity,
} from "./agentLiveActivity";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { supportsAgentAwarenessPush } from "./capabilities";
import { makeRelayDeviceRegistrationRequest, resolveApsEnvironment } from "./registrationPayload";

const REMOTE_ACTIVITY_REGISTRATION_RETRY_MS = 15_000;

const AgentAwarenessOperation = Schema.Literals([
  "read-notification-permissions",
  "read-native-push-token",
  "load-device-registration-identifier",
  "load-device-registration-preferences",
  "load-device-unregistration-identifier",
  "read-live-activity-push-token",
  "load-live-activity-registration-identifier",
  "list-active-live-activities",
  "load-live-activity-prime-preferences",
  "prime-live-activity",
]);

export class AgentAwarenessOperationError extends Schema.TaggedError<AgentAwarenessOperationError>()(
  "AgentAwarenessOperationError",
  {
    operation: AgentAwarenessOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Agent awareness operation ${this.operation} failed.`;
  }
}

// ActivityKit returns new wrappers per id; serialize by id to prevent stale-token registration.
const activityPushTokenLocks = new Map<string, Semaphore.Semaphore>();
// Each accepted registration replays the relay aggregate, repairing drifted or orphaned activities.
const ACTIVITY_TOKEN_REREGISTER_INTERVAL_MS = 60_000;
// Match the relay's STALE_AFTER_SECONDS so activities expire even if registration fails.
const LIVE_ACTIVITY_STALE_AFTER_MS = 10 * 60_000;
const liveActivityStaleDate = () => new Date(Date.now() + LIVE_ACTIVITY_STALE_AFTER_MS);
const registeredActivityPushTokens = new Map<string, number>();
let androidDeviceReplayedAt: number | null = null;
let pushTokenSubscription: { remove: () => void } | null = null;
let appStateSubscription: { remove: () => void } | null = null;

export type AgentAwarenessRegistrationStatus = "unknown" | "pending" | "registered" | "failed";
let registrationStatus: AgentAwarenessRegistrationStatus = "unknown";
const registrationStatusListeners = new Set<() => void>();

function setRegistrationStatus(next: AgentAwarenessRegistrationStatus): void {
  if (registrationStatus === next) {
    return;
  }
  registrationStatus = next;
  for (const listener of registrationStatusListeners) {
    listener();
  }
}

export function getAgentAwarenessRegistrationStatus(): AgentAwarenessRegistrationStatus {
  return registrationStatus;
}

export function subscribeAgentAwarenessRegistrationStatus(listener: () => void): () => void {
  registrationStatusListeners.add(listener);
  return () => {
    registrationStatusListeners.delete(listener);
  };
}
let activeLiveActivityRegistrationRetry: ReturnType<typeof setTimeout> | null = null;
let relayCredential: ManagedRelay.ManagedRelayCredential | null = null;
let registrationStopped = false;
let deviceRegistrationGeneration = 0;
const registrationLock = Semaphore.makeUnsafe(1);
let activeDeviceRegistration: {
  readonly input: DeviceRegistrationInput;
  operation: Promise<void>;
} | null = null;
let pendingDeviceRegistration: {
  readonly input: DeviceRegistrationInput;
  readonly context: string;
} | null = null;

interface DeviceRegistrationInput {
  readonly observedPushToken?: string;
}

interface RegisterDeviceInput extends DeviceRegistrationInput {
  readonly preferencesOverride?: Partial<Preferences>;
}

function mergeAgentAwarenessRegistrationPreferences(
  stored: Preferences,
  override: Partial<Preferences> | undefined,
): Preferences {
  return { ...stored, ...override };
}

function readRelayConfig(): { readonly url: string } | null {
  const relayUrl = resolveCloudPublicConfig().relay.url;
  if (!relayUrl) {
    return null;
  }

  return { url: relayUrl };
}

function canRegisterRemoteLiveActivities(): boolean {
  return Platform.OS === "ios";
}

function canRegisterPushNotifications(): boolean {
  return Platform.OS === "ios" || Platform.OS === "android";
}

/**
 * Sets the styal Link sign-in used for device and Live Activity registration,
 * or null on sign-out. Setting the same account again only retries a
 * registration that has not succeeded yet.
 */
export function setAgentAwarenessRelayCredential(
  credential: ManagedRelay.ManagedRelayCredential | null,
): void {
  if (credential !== null && registrationStopped) return;
  const previousAccountId = relayCredential?.accountId ?? null;
  const isExistingIdentity = credential !== null && credential.accountId === previousAccountId;
  if (!isExistingIdentity) {
    // No previous JS account is a remount; native configure checks the persisted account on cold start.
    if (previousAccountId !== null) {
      clearAndroidAgentNotifications();
    }
    androidDeviceReplayedAt = null;
    deviceRegistrationGeneration++;
    activeDeviceRegistration = null;
    pendingDeviceRegistration = null;
    registeredActivityPushTokens.clear();
  }
  relayCredential = credential;
  if (!credential) {
    clearAndroidAgentNotifications();
    pushTokenSubscription?.remove();
    pushTokenSubscription = null;
    appStateSubscription?.remove();
    appStateSubscription = null;
    if (activeLiveActivityRegistrationRetry) {
      clearTimeout(activeLiveActivityRegistrationRetry);
      activeLiveActivityRegistrationRetry = null;
    }
    // Signed-out activities would be orphaned because the relay can no longer update or end them.
    endLocalLiveActivities("live activity cleanup after cloud sign-out failed");
    setRegistrationStatus("unknown");
    void clearAgentAwarenessRegistrationRecord().catch((error: unknown) => {
      logRegistrationError("clear registration record on sign-out failed", error);
    });
    return;
  }
  ensurePushTokenListener();
  ensureAppStateListener();
  runRegistrationInBackground(
    refreshActiveLiveActivityRemoteRegistration(),
    "active live activity registration after cloud sign-in failed",
  );
  if (isExistingIdentity) {
    // A same-account re-activation only retries a registration that never succeeded.
    if (registrationStatus !== "registered") {
      enqueueDeviceRegistration({}, "device registration retry after cloud session refresh failed");
    }
    return;
  }
  enqueueDeviceRegistration({}, "device registration after cloud sign-in failed");
}

// Remounts while signed in keep the relay registration; teardown must preserve it and lock-screen activities.
export function releaseAgentAwarenessRelayCredential(): void {
  relayCredential = null;
  deviceRegistrationGeneration++;
  activeDeviceRegistration = null;
  pendingDeviceRegistration = null;
  androidDeviceReplayedAt = null;
  pushTokenSubscription?.remove();
  pushTokenSubscription = null;
  appStateSubscription?.remove();
  appStateSubscription = null;
  if (activeLiveActivityRegistrationRetry) {
    clearTimeout(activeLiveActivityRegistrationRetry);
    activeLiveActivityRegistrationRetry = null;
  }
}

/** Fences queued work and waits for dispatched registrations before the final unregister. */
export const stopAgentAwarenessRegistration = Effect.suspend(() => {
  registrationStopped = true;
  releaseAgentAwarenessRelayCredential();
  setRegistrationStatus("unknown");
  registeredActivityPushTokens.clear();
  return registrationLock.withPermits(1)(
    Effect.promise(() =>
      clearAgentAwarenessRegistrationRecord().catch((error: unknown) => {
        logRegistrationError("clear registration record on sign-out failed", error);
      }),
    ),
  );
});

/** Allows the auth bridge to activate a new sign-in, or retry after account deletion fails. */
export function resumeAgentAwarenessRegistration(): void {
  registrationStopped = false;
}

function iosMajorVersion(): number {
  const version = Platform.Version;
  if (typeof version === "number") {
    return Math.floor(version);
  }
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 18;
}

const nativePushTokenRegistration = Effect.fn("remoteRegistration.nativePushTokenRegistration")(
  function* (observedPushToken?: string) {
    if (!canRegisterPushNotifications() || !supportsAgentAwarenessPush()) {
      return { notificationsEnabled: false, pushToken: null };
    }
    const permissions = yield* Effect.tryPromise({
      try: () => Notifications.getPermissionsAsync(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "read-notification-permissions",
          cause,
        }),
    });
    if (!permissions.granted) {
      return { notificationsEnabled: false, pushToken: null };
    }
    if (observedPushToken) {
      return { notificationsEnabled: true, pushToken: observedPushToken };
    }
    const token = yield* Effect.tryPromise({
      try: () => Notifications.getDevicePushTokenAsync(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "read-native-push-token",
          cause,
        }),
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          logRegistrationError("native push token lookup failed", error);
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
    const pushToken =
      token?.type === Platform.OS && typeof token.data === "string" && token.data.trim().length > 0
        ? token.data.trim()
        : null;
    return { notificationsEnabled: pushToken !== null, pushToken };
  },
);

function registrationSignature(body: RelayDeviceRegistrationRequest): string {
  return [
    body.deviceId,
    body.pushToken ?? "",
    body.bundleId ?? "",
    body.apsEnvironment ?? "",
    body.appVersion ?? "",
    body.label,
    body.platform,
    body.iosMajorVersion,
    body.androidApiLevel,
    body.preferences.notificationsEnabled,
    body.preferences.liveActivitiesEnabled,
    body.preferences.notifyOnApproval,
    body.preferences.notifyOnInput,
    body.preferences.notifyOnCompletion,
    body.preferences.notifyOnFailure,
    body.preferences.attendedAlertDelaySeconds,
  ].join("|");
}

const registerDeviceWithRelay = Effect.fn("remoteRegistration.registerDeviceWithRelay")(function* (
  body: RelayDeviceRegistrationRequest,
  expectedGeneration: number,
): Effect.fn.Return<void, unknown, ManagedRelay.ManagedRelayClient> {
  if (expectedGeneration !== deviceRegistrationGeneration) {
    return;
  }
  const relayConfig = readRelayConfig();
  if (!relayConfig) {
    setRegistrationStatus("unknown");
    return;
  }
  const credential = relayCredential;
  if (!credential) {
    setRegistrationStatus("unknown");
    return;
  }

  // Registrations belong to a relay session, so a new sign-in of the same account registers again.
  const identity = `${credential.accountId}|${ManagedRelay.managedRelaySessionId(credential) ?? ""}`;
  const persisted = yield* Effect.tryPromise({
    try: () => loadAgentAwarenessRegistrationRecord(),
    catch: (cause) => cause,
  }).pipe(Effect.orElseSucceed(() => null));
  if (expectedGeneration !== deviceRegistrationGeneration) {
    // Signed out while the record loaded — do not resurrect the cleared
    // record or report the previous account's registration as current.
    return;
  }
  const payload = body;
  const signature = `${relayConfig.url}|${registrationSignature(payload)}`;
  // Android registration also silently replays the current card. Collapse
  // foreground bursts, but repair missed pushes on cold start or a return
  // after time away, just like re-registering an iOS activity token.
  const needsAndroidReplay =
    body.platform === "android" &&
    (androidDeviceReplayedAt === null ||
      Date.now() - androidDeviceReplayedAt >= ACTIVITY_TOKEN_REREGISTER_INTERVAL_MS);
  if (
    persisted &&
    persisted.identity === identity &&
    persisted.signature === signature &&
    !needsAndroidReplay
  ) {
    setRegistrationStatus("registered");
    return;
  }

  const client = yield* ManagedRelay.ManagedRelayClient;
  if (expectedGeneration !== deviceRegistrationGeneration) return;
  yield* client.registerDevice({
    credential,
    payload,
  });
  if (expectedGeneration !== deviceRegistrationGeneration) {
    // Signed out while the request was in flight: the sign-out path already
    // reset the status and cleared the record for the next account, so a
    // stale success must not overwrite either.
    return;
  }
  if (body.platform === "android") androidDeviceReplayedAt = Date.now();
  setRegistrationStatus("registered");
  yield* Effect.promise(() =>
    saveAgentAwarenessRegistrationRecord({
      identity,
      signature,
    }).catch((error: unknown) => {
      logRegistrationError("persist registration record failed", error);
    }),
  );
}, registrationLock.withPermits(1));

const unregisterDeviceWithRelay = Effect.fn("remoteRegistration.unregisterDeviceWithRelay")(
  function* (input: {
    readonly deviceId: string;
    readonly credential: ManagedRelay.ManagedRelayCredential;
  }): Effect.fn.Return<void, unknown, ManagedRelay.ManagedRelayClient> {
    if (!readRelayConfig()) return;
    const client = yield* ManagedRelay.ManagedRelayClient;
    yield* client.unregisterDevice({
      credential: input.credential,
      deviceId: input.deviceId,
    });
  },
);

function environmentPublishesAgentActivity(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .agentActivityPublishing !== false
  );
}

export function armAgentAwarenessLiveActivityForLocalWork(input: {
  readonly environmentId: EnvironmentId;
  readonly threadTitle: string;
  readonly projectTitle: string;
}): void {
  if (!canRegisterRemoteLiveActivities() || !relayCredential) {
    return;
  }
  if (!environmentPublishesAgentActivity(input.environmentId)) {
    return;
  }
  const generation = deviceRegistrationGeneration;
  void loadPreferences()
    .catch(() => null)
    .then((preferences) => {
      if (generation !== deviceRegistrationGeneration || !relayCredential) return;
      if (preferences?.liveActivitiesEnabled === false) {
        return;
      }
      armAgentAwarenessLiveActivityForLocalWorkNow(input);
    });
}

function armAgentAwarenessLiveActivityForLocalWorkNow(input: {
  readonly threadTitle: string;
  readonly projectTitle: string;
}): void {
  try {
    if (getAgentLiveActivities().length > 0) {
      return;
    }
    const nowIso = new Date(Date.now()).toISOString();
    const activity = startAgentLiveActivity(
      {
        title: "styal",
        subtitle: "Agent work in progress",
        activeCount: 1,
        updatedAt: nowIso,
        activities: [
          {
            environmentId: "",
            threadId: "",
            projectTitle: input.projectTitle,
            threadTitle: input.threadTitle,
            modelTitle: "",
            phase: "starting",
            status: "Connecting",
            updatedAt: nowIso,
            deepLink: "/",
          },
        ],
      },
      liveActivityStaleDate(),
    );
    if (!activity) {
      return;
    }
    runRegistrationInBackground(
      registerLiveActivityPushToken({ activity }).pipe(Effect.asVoid),
      "live activity arming after local task start failed",
    );
  } catch (error) {
    logRegistrationError("live activity arming failed", error);
  }
}

const readAgentActivitySnapshot: () => Effect.Effect<
  RelayAgentActivitySnapshotResponse | null,
  never,
  ManagedRelay.ManagedRelayClient
> = Effect.fn("remoteRegistration.readAgentActivitySnapshot")(
  function* () {
    if (!readRelayConfig()) return null;
    const credential = relayCredential;
    if (!credential) {
      return null;
    }
    const client = yield* ManagedRelay.ManagedRelayClient;
    return yield* client.getAgentActivitySnapshot({ credential });
  },
  Effect.catch((error) =>
    Effect.sync(() => {
      logRegistrationError("agent activity snapshot read failed", error);
      return null;
    }),
  ),
);

const registerLiveActivityWithRelay = Effect.fn("remoteRegistration.registerLiveActivityWithRelay")(
  function* (
    body: RelayLiveActivityRegistrationRequest,
    expectedGeneration: number,
  ): Effect.fn.Return<boolean, unknown, ManagedRelay.ManagedRelayClient> {
    if (expectedGeneration !== deviceRegistrationGeneration) return false;
    if (!readRelayConfig()) return false;
    const credential = relayCredential;
    if (!credential) return false;

    const client = yield* ManagedRelay.ManagedRelayClient;
    if (expectedGeneration !== deviceRegistrationGeneration) return false;
    yield* client.registerLiveActivity({
      credential,
      payload: body,
    });
    return expectedGeneration === deviceRegistrationGeneration;
  },
  registrationLock.withPermits(1),
);

function logRegistrationError(context: string, error: unknown): void {
  if (!__DEV__) {
    return;
  }
  console.warn(`[agent-awareness] ${context}`, {
    message: error instanceof Error ? error.message : String(error),
    traceId: findErrorTraceId(error),
    error,
  });
}

function runRegistrationInBackground(
  operation: Effect.Effect<unknown, unknown, ManagedRelay.ManagedRelayClient>,
  context: string,
): void {
  void (async () => {
    const result = await settleAsyncResult(() => runtime.runPromiseExit(operation));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      logRegistrationError(context, squashAtomCommandFailure(result));
    }
  })();
}

function mergeDeviceRegistrationInput(
  current: DeviceRegistrationInput,
  next: DeviceRegistrationInput,
): DeviceRegistrationInput {
  const observedPushToken = next.observedPushToken ?? current.observedPushToken;
  return observedPushToken ? { observedPushToken } : {};
}

function registrationAddsInformation(
  current: DeviceRegistrationInput,
  next: DeviceRegistrationInput,
): boolean {
  return (
    next.observedPushToken !== undefined && next.observedPushToken !== current.observedPushToken
  );
}

function startPendingDeviceRegistration(): void {
  if (activeDeviceRegistration || !pendingDeviceRegistration) {
    return;
  }

  const next = pendingDeviceRegistration;
  pendingDeviceRegistration = null;
  const generation = deviceRegistrationGeneration;
  if (registrationStatus !== "registered") {
    setRegistrationStatus("pending");
  }
  const registration = {
    input: next.input,
    operation: Promise.resolve(),
  };
  activeDeviceRegistration = registration;
  registration.operation = (async () => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(registerDevice(next.input, generation)),
    );
    if (
      generation === deviceRegistrationGeneration &&
      result._tag === "Failure" &&
      !isAtomCommandInterrupted(result)
    ) {
      // Refresh failures leave the relay's accepted registration intact; preserve registered status.
      if (registrationStatus !== "registered") {
        setRegistrationStatus("failed");
      }
      logRegistrationError(next.context, squashAtomCommandFailure(result));
    }
    if (activeDeviceRegistration === registration) {
      activeDeviceRegistration = null;
    }
    startPendingDeviceRegistration();
  })();
}

function enqueueDeviceRegistration(input: DeviceRegistrationInput, context: string): void {
  if (!relayCredential) return;
  if (
    activeDeviceRegistration &&
    !registrationAddsInformation(activeDeviceRegistration.input, input)
  ) {
    return;
  }

  pendingDeviceRegistration = pendingDeviceRegistration
    ? {
        input: mergeDeviceRegistrationInput(pendingDeviceRegistration.input, input),
        context,
      }
    : { input, context };
  startPendingDeviceRegistration();
}

const registerDevice = Effect.fn("remoteRegistration.registerDevice")(function* (
  input: RegisterDeviceInput = {},
  expectedGeneration = deviceRegistrationGeneration,
): Effect.fn.Return<void, unknown, ManagedRelay.ManagedRelayClient> {
  if (!relayCredential || expectedGeneration !== deviceRegistrationGeneration) return;
  if (!canRegisterPushNotifications()) {
    return;
  }

  const [deviceId, storedPreferences] = yield* Effect.all([
    Effect.tryPromise({
      try: () => loadOrCreateAgentAwarenessDeviceId(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "load-device-registration-identifier",
          cause,
        }),
    }),
    Effect.tryPromise({
      try: () => loadPreferences(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "load-device-registration-preferences",
          cause,
        }),
    }),
  ]);
  const preferences = mergeAgentAwarenessRegistrationPreferences(
    storedPreferences,
    input.preferencesOverride,
  );
  if (expectedGeneration !== deviceRegistrationGeneration) return;
  if (relayCredential) {
    configureAndroidAgentNotifications(
      deviceId,
      relayCredential.accountId,
      preferences.liveActivitiesEnabled !== false,
    );
  }
  const pushTokenRegistration = yield* nativePushTokenRegistration(input?.observedPushToken);
  const bundleId =
    Platform.OS === "android"
      ? Constants.expoConfig?.android?.package?.trim()
      : Constants.expoConfig?.ios?.bundleIdentifier?.trim();
  yield* registerDeviceWithRelay(
    makeRelayDeviceRegistrationRequest({
      deviceId,
      label:
        Constants.deviceName?.trim() ||
        (Platform.OS === "android" ? "Android device" : "iOS device"),
      ...(Platform.OS === "android"
        ? { platform: "android" as const, androidApiLevel: Number(Platform.Version) }
        : { platform: "ios" as const, iosMajorVersion: iosMajorVersion() }),
      appVersion: Constants.expoConfig?.version,
      ...(bundleId ? { bundleId } : {}),
      ...(Platform.OS === "ios"
        ? { apsEnvironment: resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant) }
        : {}),
      ...(pushTokenRegistration.pushToken ? { pushToken: pushTokenRegistration.pushToken } : {}),
      notificationsEnabled: pushTokenRegistration.notificationsEnabled,
      preferences,
    }),
    expectedGeneration,
  );
});

function registerDeviceForCurrentUser(): Effect.Effect<
  void,
  unknown,
  ManagedRelay.ManagedRelayClient
> {
  return registerDevice(undefined);
}

function ensurePushTokenListener(): void {
  if (pushTokenSubscription || !canRegisterPushNotifications()) {
    return;
  }

  pushTokenSubscription = Notifications.addPushTokenListener((token) => {
    if (
      token.type === Platform.OS &&
      typeof token.data === "string" &&
      token.data.trim().length > 0
    ) {
      enqueueDeviceRegistration(
        { observedPushToken: token.data.trim() },
        "native push token rotation registration failed",
      );
    }
  });
}

function ensureAppStateListener(): void {
  if (appStateSubscription || !canRegisterPushNotifications()) {
    return;
  }

  appStateSubscription = AppState.addEventListener("change", (state) => {
    if (state !== "active") {
      return;
    }
    enqueueDeviceRegistration({}, "device registration after app foreground failed");
    runRegistrationInBackground(
      refreshActiveLiveActivityRemoteRegistration(),
      "active live activity reconciliation after app foreground failed",
    );
  });
}

// Binaries built before the native dismissEnded method throw here.
function dismissEndedLocalLiveActivities(): void {
  try {
    dismissEndedAgentLiveActivities();
  } catch (error) {
    logRegistrationError("ended live activity cleanup failed", error);
  }
}

function endLocalLiveActivities(context: string): void {
  if (!canRegisterRemoteLiveActivities()) {
    return;
  }
  dismissEndedLocalLiveActivities();
  try {
    for (const activity of getAgentLiveActivities()) {
      activity.end("immediate").catch((error: unknown) => {
        logRegistrationError(context, error);
      });
    }
  } catch (error) {
    logRegistrationError(context, error);
  }
}

export function refreshAgentAwarenessRegistration(): Effect.Effect<
  void,
  never,
  ManagedRelay.ManagedRelayClient
> {
  return registerDeviceForCurrentUser().pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        if (registrationStatus !== "registered") {
          setRegistrationStatus("failed");
        }
        logRegistrationError("device registration refresh failed", error);
      }),
    ),
  );
}

export function updateAgentAwarenessRegistrationPreferences(
  preferencesOverride: Partial<Preferences>,
): Effect.Effect<void, unknown, ManagedRelay.ManagedRelayClient> {
  return registerDevice({ preferencesOverride }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        if (registrationStatus !== "registered") {
          setRegistrationStatus("failed");
        }
        logRegistrationError("device preference registration refresh failed", error);
      }),
    ),
  );
}

export function __resetAgentAwarenessRemoteRegistrationForTest(): void {
  pushTokenSubscription?.remove();
  pushTokenSubscription = null;
  appStateSubscription?.remove();
  appStateSubscription = null;
  if (activeLiveActivityRegistrationRetry) {
    clearTimeout(activeLiveActivityRegistrationRetry);
    activeLiveActivityRegistrationRetry = null;
  }
  relayCredential = null;
  registrationStopped = false;
  deviceRegistrationGeneration++;
  activeDeviceRegistration = null;
  pendingDeviceRegistration = null;
  registrationStatus = "unknown";
  androidDeviceReplayedAt = null;
  registrationStatusListeners.clear();
  registeredActivityPushTokens.clear();
  activityPushTokenLocks.clear();
}

export const unregisterAgentAwarenessDeviceForCurrentUser: (
  credential: ManagedRelay.ManagedRelayCredential,
) => Effect.Effect<void, never, ManagedRelay.ManagedRelayClient> = Effect.fn(
  "remoteRegistration.unregisterAgentAwarenessDeviceForCurrentUser",
)(
  function* (credential: ManagedRelay.ManagedRelayCredential) {
    const deviceId = yield* Effect.tryPromise({
      try: () => loadAgentAwarenessDeviceId(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "load-device-unregistration-identifier",
          cause,
        }),
    });
    if (!deviceId) {
      return;
    }
    yield* unregisterDeviceWithRelay({ deviceId, credential });
  },
  Effect.catch((error) =>
    Effect.sync(() => {
      logRegistrationError("device unregistration failed", error);
    }),
  ),
);

export const registerLiveActivityPushToken = Effect.fn(
  "remoteRegistration.registerLiveActivityPushToken",
)(function* (
  input: {
    readonly activity: LiveActivity<AgentActivityProps>;
  },
  expectedGeneration: number = deviceRegistrationGeneration,
): Effect.fn.Return<boolean, unknown, ManagedRelay.ManagedRelayClient> {
  if (expectedGeneration !== deviceRegistrationGeneration) return false;
  if (!canRegisterRemoteLiveActivities()) {
    return false;
  }

  const lock = observeLiveActivityPushTokens(input.activity);
  return yield* lock.withPermit(
    Effect.gen(function* () {
      const activityPushToken = yield* Effect.tryPromise({
        try: () => input.activity.getPushToken(),
        catch: (cause) =>
          new AgentAwarenessOperationError({
            operation: "read-live-activity-push-token",
            cause,
          }),
      });
      if (expectedGeneration !== deviceRegistrationGeneration) return false;
      if (!activityPushToken) {
        return false;
      }

      return yield* registerLiveActivityPushTokenValue({ activityPushToken }, expectedGeneration);
    }),
  );
});

// Observe every token replacement: the relay otherwise keeps pushing to the old token until APNs rejects it.
function observeLiveActivityPushTokens(
  activity: LiveActivity<AgentActivityProps>,
): Semaphore.Semaphore {
  const activityId = activity.getId();
  const existing = activityPushTokenLocks.get(activityId);
  if (existing) return existing;
  const lock = Semaphore.makeUnsafe(1);
  activityPushTokenLocks.set(activityId, lock);
  activity.addPushTokenListener((event) => {
    if (!event.pushToken) return;
    runRegistrationInBackground(
      lock.withPermit(
        registerLiveActivityPushTokenValue(
          { activityPushToken: event.pushToken },
          deviceRegistrationGeneration,
        ),
      ),
      "live activity token listener registration failed",
    );
  });
  return lock;
}

const registerLiveActivityPushTokenValue = Effect.fn(
  "remoteRegistration.registerLiveActivityPushTokenValue",
)(function* (
  input: {
    readonly activityPushToken: string;
  },
  expectedGeneration: number,
): Effect.fn.Return<boolean, unknown, ManagedRelay.ManagedRelayClient> {
  if (!relayCredential || expectedGeneration !== deviceRegistrationGeneration) return false;
  const acceptedAt = registeredActivityPushTokens.get(input.activityPushToken);
  if (acceptedAt !== undefined && Date.now() - acceptedAt < ACTIVITY_TOKEN_REREGISTER_INTERVAL_MS) {
    return true;
  }
  const deviceId = yield* Effect.tryPromise({
    try: () => loadOrCreateAgentAwarenessDeviceId(),
    catch: (cause) =>
      new AgentAwarenessOperationError({
        operation: "load-live-activity-registration-identifier",
        cause,
      }),
  });
  if (expectedGeneration !== deviceRegistrationGeneration) return false;
  const registered = yield* registerLiveActivityWithRelay(
    {
      deviceId,
      activityPushToken: input.activityPushToken,
    },
    expectedGeneration,
  );
  if (expectedGeneration !== deviceRegistrationGeneration) return false;
  if (registered) {
    registeredActivityPushTokens.set(input.activityPushToken, Date.now());
  }
  return registered;
});

function scheduleActiveLiveActivityRegistrationRetry(): void {
  if (activeLiveActivityRegistrationRetry || !relayCredential) {
    return;
  }

  activeLiveActivityRegistrationRetry = setTimeout(() => {
    activeLiveActivityRegistrationRetry = null;
    runRegistrationInBackground(
      refreshActiveLiveActivityRemoteRegistration(),
      "active live activity token retry failed",
    );
  }, REMOTE_ACTIVITY_REGISTRATION_RETRY_MS);
}

const refreshActiveLiveActivityRemoteRegistration = Effect.fn(
  "remoteRegistration.refreshActiveLiveActivityRemoteRegistration",
)(function* (): Effect.fn.Return<void, never, ManagedRelay.ManagedRelayClient> {
  const generation = deviceRegistrationGeneration;
  if (!canRegisterRemoteLiveActivities() || !relayCredential) {
    return;
  }

  dismissEndedLocalLiveActivities();
  let activities = yield* Effect.try({
    try: () => getAgentLiveActivities(),
    catch: (cause) =>
      new AgentAwarenessOperationError({
        operation: "list-active-live-activities",
        cause,
      }),
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logRegistrationError("active live activity lookup failed", error);
        return [] as ReadonlyArray<LiveActivity<AgentActivityProps>>;
      }),
    ),
  );

  // The relay tracks exactly one card per device; if concurrent arming ever
  // produced extras, end them so only one keeps receiving updates.
  if (activities.length > 1) {
    for (const extra of activities.slice(1)) {
      extra.end("immediate").catch((error: unknown) => {
        logRegistrationError("duplicate live activity cleanup failed", error);
      });
    }
    activities = activities.slice(0, 1);
  }

  // Activities are only ever created here, in the foreground, where the
  // update token can be observed and registered immediately — the relay never
  // remote-starts one (background push-to-start wakes proved too unreliable
  // to hand the token over).
  if (activities.length === 0) {
    const preferences = yield* Effect.tryPromise({
      try: () => loadPreferences(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "load-live-activity-prime-preferences",
          cause,
        }),
    }).pipe(Effect.orElseSucceed(() => null));
    if (generation !== deviceRegistrationGeneration) return;
    if (preferences?.liveActivitiesEnabled !== false) {
      const snapshot = yield* readAgentActivitySnapshot();
      if (generation !== deviceRegistrationGeneration) return;
      // The snapshot request yields; an arm-on-send may have created the
      // card in the meantime. Re-check so two cards are never started.
      const armedMeanwhile = yield* Effect.try({
        try: () => getAgentLiveActivities(),
        catch: () => [] as ReadonlyArray<LiveActivity<AgentActivityProps>>,
      }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<LiveActivity<AgentActivityProps>>));
      if (armedMeanwhile.length > 0) {
        activities = [...armedMeanwhile];
      } else if (snapshot?.aggregate && snapshot.aggregate.activeCount > 0) {
        const aggregate = snapshot.aggregate;
        const primed = yield* Effect.try({
          try: () =>
            startAgentLiveActivity(
              {
                title: aggregate.title,
                subtitle: aggregate.subtitle,
                activeCount: aggregate.activeCount,
                updatedAt: aggregate.updatedAt,
                activities: aggregate.activities,
              },
              liveActivityStaleDate(),
            ),
          catch: (cause) =>
            new AgentAwarenessOperationError({
              operation: "prime-live-activity",
              cause,
            }),
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              logRegistrationError("live activity priming failed", error);
              return null;
            }),
          ),
        );
        if (primed) {
          activities = [primed];
        }
      }
    }
  }

  if (generation !== deviceRegistrationGeneration) return;
  const registrationResults = yield* Effect.forEach(activities, (activity) =>
    registerLiveActivityPushToken({ activity }, generation).pipe(
      Effect.map((registered) => !registered),
      Effect.catch((error) =>
        Effect.sync(() => {
          logRegistrationError("active live activity token registration failed", error);
          return true;
        }),
      ),
    ),
  );

  if (generation !== deviceRegistrationGeneration) return;
  if (registrationResults.some(Boolean)) {
    scheduleActiveLiveActivityRegistrationRetry();
  }
});
