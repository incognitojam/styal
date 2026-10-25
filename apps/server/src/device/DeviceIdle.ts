/**
 * The agent-device daemon never releases a device claim while the server runs, so closing a
 * device here releases both the service session and the claim. Idle holds yield to another
 * agent's open; holds of working or watched devices need an explicit takeover. Only devices
 * this server booted are shut down when idle.
 */
import {
  DeviceHeldError,
  DeviceOperationError,
  DeviceHostId,
  DeviceId,
  DevicePlatform,
  type DeviceServiceState,
  type DeviceOpenInput,
  type DeviceError,
  type SimulatorMemoryMode,
  type DeviceSession,
  type DeviceShutdownInput,
  LOCAL_DEVICE_HOST_ID,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { releasedAgentSessionsPath } from "./AgentDeviceShim.ts";
import { agentDeviceSession, readAgentDeviceConfig } from "./AgentDeviceTarget.ts";
import type { AgentDeviceEndpoint } from "./DeviceHost.ts";
import * as DeviceService from "./DeviceService.ts";
import { environmentDeviceHostId } from "./EnvironmentDeviceHost.ts";

const SWEEP_INTERVAL = Duration.minutes(1);
const RELEASE_TIMEOUT = Duration.seconds(15);
/** Sessions a connected environment opened here. */
const PEER_THREAD_PREFIX = "device-peer-";

type DeviceRef = { readonly hostId: DeviceHostId; readonly deviceId: DeviceId };

interface DeviceActivityShape {
  /** Counts a client streaming the device for the scope's lifetime; watched devices are never idle. */
  readonly watch: (
    hostId: DeviceHostId,
    deviceId: DeviceId,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Marks devices with a session from a matching thread as in use now. */
  readonly touchThreads: (match: (threadId: ThreadId) => boolean) => Effect.Effect<void>;
  /** Remembers which environment a peer thread prefix belongs to, so its claims can be named. */
  readonly notePeer: (threadPrefix: string, environmentId: string) => void;
  /**
   * Other threads' sessions that an agent open in `threadId` must not take silently:
   * their agent is working, someone watches the device, or another environment holds it.
   */
  readonly inUse: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<ThreadDeviceRef>>;
}

type ThreadDeviceRef = DeviceRef & { readonly threadId: ThreadId };

/** Whether a thread can still use the devices it holds. */
export type DeviceThreadStatus = "working" | "idle" | "archived" | "missing";

/**
 * Use the transports report. The default ignores it, so code paths built
 * without the live device layer need no setup.
 */
export class DeviceActivity extends Context.Reference<DeviceActivityShape>(
  "@styal/cli/device/DeviceActivity",
  {
    defaultValue: () => ({
      watch: () => Effect.void,
      touchThreads: () => Effect.void,
      notePeer: () => {},
      inUse: () => Effect.succeed([]),
    }),
  },
) {}

/** The device a stream socket views, if any. */
const streamedDeviceId = (path: string, search: URLSearchParams) =>
  /^\/vendor\/serve-(sim\/helper|emu)\/ws$/.test(path) ? search.get("device") || null : null;

/** Holds a viewer on the device a hub stream socket views while the socket stays open. */
export const whileStreaming =
  (hostId: DeviceHostId, path: string, search: URLSearchParams) =>
  <A, E, R>(proxied: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const deviceId = streamedDeviceId(path, search);
      if (!deviceId) return yield* proxied;
      const activity = yield* DeviceActivity;
      return yield* Effect.scoped(activity.watch(hostId, deviceId).pipe(Effect.andThen(proxied)));
    });

const DeviceBootRecord = Schema.Struct({
  hostId: DeviceHostId,
  deviceId: DeviceId,
  name: Schema.String,
  platform: DevicePlatform,
});
type DeviceBootRecord = typeof DeviceBootRecord.Type;
const DeviceBootRecords = Schema.Array(DeviceBootRecord);

/**
 * Devices this server booted, kept across restarts so idle shutdown never
 * mistakes them for ones the user started outside styal.
 */
export interface DeviceBootLedger {
  readonly load: Effect.Effect<ReadonlyArray<DeviceBootRecord>>;
  readonly save: (records: ReadonlyArray<DeviceBootRecord>) => Effect.Effect<void>;
}

/** JSON-RPC reply from the agent-device daemon's `/rpc` endpoint. */
const AgentDeviceRpcReply = Schema.Union([
  Schema.Struct({ result: Schema.Struct({ ok: Schema.Boolean }) }),
  Schema.Struct({
    error: Schema.Struct({
      message: Schema.String,
      data: Schema.optional(Schema.Struct({ code: Schema.optional(Schema.String) })),
    }),
  }),
]);

/** An agent's hold on a device: the thread and every agent-device session name it was given. */
interface Hold extends DeviceRef {
  readonly threadId: ThreadId;
  readonly names: ReadonlyArray<string>;
}

const deviceKey = (hostId: string, deviceId: string) => JSON.stringify([hostId, deviceId]);
const holdKey = (threadId: string, hostId: string, deviceId: string) =>
  JSON.stringify([threadId, hostId, deviceId]);
const onDevice = (hostId: string, deviceId: string) => (entry: DeviceRef) =>
  entry.hostId === hostId && entry.deviceId === deviceId;

/** A thread still working may drive its devices at any moment. */
const threadStatus = (thread: OrchestrationV2ThreadShell | null): DeviceThreadStatus =>
  thread === null
    ? "missing"
    : thread.activeRunId !== null || (thread.pendingBackgroundTasks?.length ?? 0) > 0
      ? "working"
      : thread.archivedAt !== null
        ? "archived"
        : "idle";

export const make = Effect.fn("DeviceIdle.make")(function* (
  inner: DeviceService.DeviceService["Service"],
  options: {
    readonly ledger: DeviceBootLedger;
    /** agent-device sessions handed back or over, which the launcher refuses until reissued. */
    readonly releasedSessions: {
      readonly load: Effect.Effect<ReadonlyArray<string>>;
      readonly save: (names: ReadonlyArray<string>) => Effect.Effect<void>;
    };
    /** The agent-device daemon agents on this device use, or null when none can hold claims. */
    readonly agentEndpoint: (
      hostId: DeviceHostId,
      deviceId: DeviceId,
    ) => Effect.Effect<AgentDeviceEndpoint | null>;
    /** This environment's id, which connected environments use to name their claims here. */
    readonly environmentId: string;
    readonly threadStatus: (threadId: ThreadId) => Effect.Effect<DeviceThreadStatus>;
    readonly memoryModeForThread?: (
      input: DeviceOpenInput,
    ) => Effect.Effect<SimulatorMemoryMode, DeviceError>;
  },
) {
  const { ledger } = options;
  const crypto = yield* Crypto.Crypto;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const booted = new Map(
    (yield* ledger.load).map((record) => [deviceKey(record.hostId, record.deviceId), record]),
  );
  // Idle time counts from server start for devices from before a restart.
  const startedAt = yield* Clock.currentTimeMillis;
  const lastUsedAt = new Map<string, number>();
  const viewers = new Map<string, number>();
  /**
   * agent-device session names handed out by `agentTarget`, keyed by the device id asked
   * for. A connected environment's host namespaces its names, so an agent open cannot
   * derive them itself. Only `agentRequested` makes an open an agent's: device_open also
   * targets the device after opening it, so no later open may count on a targeting call.
   */
  const targeted = new Map<string, string>();
  const holds = new Map<string, Hold>();
  /** Claims whose release the daemon did not confirm, retried on the next reclaim or power-off. */
  const unreleased = new Map<string, Hold>();
  const peers = new Map<string, string>();
  const releasedNames = new Set(yield* options.releasedSessions.load);
  const releasedLock = yield* Semaphore.make(1);
  const setReleased = (names: ReadonlyArray<string>, released: boolean) =>
    Effect.suspend(() => {
      let changed = false;
      for (const name of names) {
        if (releasedNames.has(name) === released) continue;
        if (released) releasedNames.add(name);
        else releasedNames.delete(name);
        changed = true;
      }
      return changed ? options.releasedSessions.save([...releasedNames]) : Effect.void;
    }).pipe(releasedLock.withPermit);
  const locks = new Map<string, Semaphore.Semaphore>();

  /**
   * Serializes lifecycle work on one device so a reopen cannot interleave with a
   * release. An Android device is locked by AVD name, which stays the same when
   * it boots under a new serial.
   */
  const withDevice =
    (hostId: string, deviceId: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      inner.state.pipe(
        Effect.flatMap((state) => {
          const device = state.devices.find(
            (candidate) =>
              candidate.hostId === hostId &&
              (candidate.id === deviceId ||
                (candidate.platform === "android" && candidate.name === deviceId)),
          );
          const key =
            device?.platform === "android"
              ? JSON.stringify([hostId, "android", device.name])
              : deviceKey(hostId, deviceId);
          let lock = locks.get(key);
          if (!lock) locks.set(key, (lock = Semaphore.makeUnsafe(1)));
          return lock.withPermit(effect);
        }),
      );
  const markUsed = (key: string) =>
    Clock.currentTimeMillis.pipe(Effect.map((now) => void lastUsedAt.set(key, now)));
  const idleFor = (key: string) =>
    Clock.currentTimeMillis.pipe(Effect.map((now) => now - (lastUsedAt.get(key) ?? startedAt)));
  const forget = (keys: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      const removed = keys.filter((key) => booted.delete(key));
      return removed.length === 0 ? Effect.void : ledger.save([...booted.values()]);
    });
  /** A device a listing shows was shut down or replaced outside styal is no longer one this server booted. */
  const prune = (state: DeviceServiceState) =>
    forget(
      [...booted].flatMap(([key, record]) => {
        const listed = state.devices.filter((device) => device.hostId === record.hostId);
        if (listed.length === 0) return [];
        const device = listed.find((candidate) => candidate.id === record.deviceId);
        return device?.booted && device.name === record.name ? [] : [key];
      }),
    );

  /**
   * The hold a session stands for, if it is an agent's. A connected environment
   * names its claims from its own id and this environment's host id there; an
   * Android device may have been asked for by AVD name before it booted.
   */
  const holdFor = Effect.fn("DeviceIdle.holdFor")(function* (
    session: DeviceSession,
    state: DeviceServiceState,
  ) {
    const own = holds.get(holdKey(session.threadId, session.hostId, session.deviceId));
    if (own) return own;
    if (!session.threadId.startsWith(PEER_THREAD_PREFIX)) return undefined;
    const separator = session.threadId.indexOf(":");
    const environmentId = peers.get(session.threadId.slice(0, separator + 1));
    if (!environmentId) return undefined;
    const device = state.devices.find(
      (candidate) => candidate.hostId === session.hostId && candidate.id === session.deviceId,
    );
    const ids = [session.deviceId, ...(device && device.name !== device.id ? [device.name] : [])];
    return {
      threadId: session.threadId,
      hostId: session.hostId,
      deviceId: session.deviceId,
      names: yield* Effect.forEach(ids, (id) =>
        agentDeviceSession(
          `${environmentId}:${session.threadId.slice(separator + 1)}`,
          environmentDeviceHostId(options.environmentId),
          id,
        ).pipe(Effect.provideService(Crypto.Crypto, crypto)),
      ),
    } satisfies Hold;
  });

  const threadBusy = (threadId: ThreadId) =>
    options.threadStatus(threadId).pipe(Effect.map((status) => status === "working"));
  /** Reclaim only local holders: another environment's launcher cannot revoke its old session here. */
  const holderIdle = (hold: Hold) =>
    hold.threadId.startsWith(PEER_THREAD_PREFIX)
      ? Effect.succeed(false)
      : threadBusy(hold.threadId).pipe(Effect.map((busy) => !busy));

  /** See `DeviceActivity.inUse`. */
  const inUseBy = Effect.fn("DeviceIdle.inUseBy")(function* (
    threadId: ThreadId,
    state: DeviceServiceState,
  ) {
    const found: Array<ThreadDeviceRef> = [];
    for (const session of state.sessions) {
      if (session.threadId === threadId) continue;
      const hold = yield* holdFor(session, state);
      if (
        viewers.has(deviceKey(session.hostId, session.deviceId)) ||
        (hold && !(yield* holderIdle(hold)))
      )
        found.push(session);
    }
    // A device environment lists this environment's own sessions among its others.
    for (const session of state.externalSessions ?? []) {
      if (
        session.threadId !== threadId &&
        !state.sessions.some(
          (own) => own.threadId === session.threadId && onDevice(own.hostId, own.deviceId)(session),
        )
      )
        found.push(session);
    }
    return found.map(({ threadId, hostId, deviceId }) => ({ threadId, hostId, deviceId }));
  });

  /** Attempts every session independently and returns only names whose cleanup remains uncertain. */
  const releaseClaim = Effect.fn("DeviceIdle.releaseClaim")(function* (
    hold: Hold,
    uncertain: ReadonlySet<string>,
  ) {
    // Peer sessions run on this environment's own daemon.
    const endpoint = yield* options.agentEndpoint(
      hold.threadId.startsWith(PEER_THREAD_PREFIX) ? LOCAL_DEVICE_HOST_ID : hold.hostId,
      hold.deviceId,
    );
    // No daemon means no claims: they belong to the daemon that is gone.
    if (!endpoint) return [];
    const pending: string[] = [];
    for (const name of hold.names) {
      const result = yield* HttpClientRequest.post(`${endpoint.baseUrl}/rpc`).pipe(
        HttpClientRequest.bearerToken(endpoint.token),
        HttpClientRequest.setHeader("x-agent-device-token", endpoint.token),
        HttpClientRequest.bodyJson({
          jsonrpc: "2.0",
          id: name,
          method: "agent_device.command",
          params: { session: name, command: "close", positionals: [], flags: {} },
        }),
        Effect.flatMap((request) => httpClient.execute(request)),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(AgentDeviceRpcReply)),
        Effect.scoped,
        Effect.timeout(RELEASE_TIMEOUT),
        Effect.result,
      );
      const reply = result._tag === "Success" ? result.success : null;
      const absent =
        reply !== null && "error" in reply && reply.error.data?.code === "SESSION_NOT_FOUND";
      if (reply && ("result" in reply ? reply.result.ok : absent && !uncertain.has(name))) continue;
      // Failed platform cleanup can remove the session while retaining its claim.
      // Keep that uncertainty per name, without preventing cleanup of later names.
      pending.push(name);
      yield* Effect.logWarning(
        absent
          ? "Device claim may stay held until its daemon restarts"
          : "Could not release device session; will retry",
        {
          threadId: hold.threadId,
          hostId: hold.hostId,
          deviceId: hold.deviceId,
          session: name,
          cause: result._tag === "Failure" ? result.failure : reply,
        },
      );
    }
    return pending;
  });

  /** Releases a hold, retaining only unconfirmed session names for the next hand-over or power-off. */
  const release = Effect.fn("DeviceIdle.release")(function* (hold: Hold) {
    const key = holdKey(hold.threadId, hold.hostId, hold.deviceId);
    const uncertain = new Set(unreleased.get(key)?.names ?? []);
    const names = [...new Set([...hold.names, ...uncertain])];
    yield* setReleased(names, true);
    const pending = yield* releaseClaim({ ...hold, names }, uncertain);
    holds.delete(key);
    if (pending.length > 0) unreleased.set(key, { ...hold, names: pending });
    else unreleased.delete(key);
  });

  /** Retries orphaned claims; a reopened hold retains its uncertainty until it is eligible for release. */
  const retryUnreleased = (hostId: string, deviceId: string) =>
    Effect.forEach(
      [...unreleased.values()].filter(
        (hold) =>
          onDevice(hostId, deviceId)(hold) &&
          !holds.has(holdKey(hold.threadId, hold.hostId, hold.deviceId)),
      ),
      release,
      { discard: true },
    );

  /** Releases every claim on a device before it powers off; one held on a powered-off device never clears. */
  const releaseDevice = Effect.fn("DeviceIdle.releaseDevice")(function* (
    hostId: string,
    deviceId: string,
  ) {
    const state = yield* inner.state;
    for (const session of state.sessions.filter(onDevice(hostId, deviceId))) {
      const hold = yield* holdFor(session, state);
      if (hold) yield* release(hold);
    }
    yield* retryUnreleased(hostId, deviceId);
  });

  /**
   * Hands over a device from other threads that hold it but are not using it, or
   * from every local holder on a take-over. A connected environment's hold is never
   * released here: its agents reach the daemon directly, past the launcher that
   * refuses released sessions.
   */
  const reclaim = Effect.fn("DeviceIdle.reclaim")(function* (
    threadId: ThreadId,
    hostId: string,
    deviceId: string,
    takeOver: boolean,
  ) {
    // Someone watching the device keeps it with its holders.
    if (!takeOver && viewers.has(deviceKey(hostId, deviceId))) return;
    const state = yield* inner.state;
    for (const session of state.sessions.filter(onDevice(hostId, deviceId))) {
      if (session.threadId === threadId || session.threadId.startsWith(PEER_THREAD_PREFIX))
        continue;
      const hold = yield* holdFor(session, state);
      if (!hold || (!takeOver && !(yield* holderIdle(hold)))) continue;
      yield* release(hold);
      yield* inner.close({ threadId: session.threadId, hostId, deviceId });
      yield* Effect.logInfo("Handed device to another thread", {
        from: session.threadId,
        threadId,
        hostId,
        deviceId,
        takeOver,
      });
    }
    yield* retryUnreleased(hostId, deviceId);
  });

  const agentTarget: DeviceService.DeviceService["Service"]["agentTarget"] = (input) =>
    inner.agentTarget(input).pipe(
      Effect.tap(({ args }) => {
        const name = args[args.indexOf("--session") + 1];
        if (!name) return Effect.void;
        const key = holdKey(input.threadId, input.hostId, input.deviceId);
        targeted.set(key, name);
        // Under the device lock, a hand-over has either released this thread's hold
        // already or has not started, so it releases the name added here too.
        return Effect.suspend(() => {
          const hold = holds.get(key);
          if (!hold) return Effect.void;
          if (!hold.names.includes(name)) holds.set(key, { ...hold, names: [...hold.names, name] });
          // device_open targets a device again once it runs, and a booted Android device's
          // serial names a session that an earlier power-off may have refused, even one a
          // reopen carried over because its cleanup was never confirmed.
          return setReleased([name], false);
        }).pipe(withDevice(input.hostId, input.deviceId));
      }),
    );

  // The service publishes a booting entry only when it boots the device itself.
  const open: DeviceService.DeviceService["Service"]["open"] = (input, memoryMode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const hostId = input.hostId ?? LOCAL_DEVICE_HOST_ID;
        const asked = holdKey(input.threadId, hostId, input.deviceId);
        const name =
          typeof memoryMode === "object" && memoryMode.agentRequested
            ? (targeted.get(asked) ??
              (yield* agentDeviceSession(input.threadId, hostId, input.deviceId).pipe(
                Effect.provideService(Crypto.Crypto, crypto),
              )))
            : undefined;
        // Only an agent open hands a device over or is refused one; the user opening a
        // panel shares the stream and never takes the device from an agent.
        if (name) {
          // A thread reopening a device it already holds is never refused.
          const held = holds.has(asked)
            ? []
            : (yield* inUseBy(input.threadId, yield* inner.state)).filter(
                onDevice(hostId, input.deviceId),
              );
          if (held.length > 0 && input.takeOver !== true) {
            return yield* new DeviceHeldError({
              hostId,
              deviceId: input.deviceId,
              threadIds: [...new Set(held.map((entry) => entry.threadId))],
            });
          }
          yield* reclaim(input.threadId, hostId, input.deviceId, input.takeOver === true);
        }
        const updates = yield* inner.subscribe;
        const mode =
          input.platform === "android"
            ? "standard"
            : ((typeof memoryMode === "string" ? memoryMode : undefined) ??
              (yield* options.memoryModeForThread?.(input) ?? Effect.succeed("standard" as const)));
        const session = yield* inner.open(
          input,
          typeof memoryMode === "object" ? { ...memoryMode, memoryMode: mode } : mode,
        );
        const key = deviceKey(session.hostId, session.deviceId);
        const states = yield* PubSub.takeUpTo(updates, 10_000);
        const bootedHere = states.some((state) =>
          state.bootingDevices?.some(
            (device) => device.hostId === session.hostId && device.id === input.deviceId,
          ),
        );
        const device = (yield* inner.state).devices.find(
          (candidate) => candidate.hostId === session.hostId && candidate.id === session.deviceId,
        );
        if (bootedHere && device) {
          booted.set(key, {
            hostId: session.hostId,
            deviceId: session.deviceId,
            name: device.name,
            platform: device.platform,
          });
          yield* ledger.save([...booted.values()]);
        }
        if (name) {
          // Only a completed open hands the session out again. Keep it refused while
          // a concurrent hand-over is releasing this thread's earlier session.
          yield* setReleased([name], false);
          const opened = holdKey(session.threadId, session.hostId, session.deviceId);
          // A thread reopening a device keeps every session name it was given until each is released.
          const previous = [
            ...(holds.get(opened)?.names ?? []),
            ...(unreleased.get(opened)?.names ?? []),
          ];
          // Reissuing launcher permission does not confirm earlier daemon cleanup.
          holds.set(opened, {
            threadId: session.threadId,
            hostId: session.hostId,
            deviceId: session.deviceId,
            names: [...new Set([...previous, name])],
          });
        }
        yield* markUsed(key);
        return session;
      }),
    ).pipe(withDevice(input.hostId ?? LOCAL_DEVICE_HOST_ID, input.deviceId));

  const poweredOff = (hostId: string, deviceId: string) => forget([deviceKey(hostId, deviceId)]);

  const closeOne = Effect.fn("DeviceIdle.closeOne")(function* (
    session: DeviceSession,
    shutdown: boolean,
  ) {
    if (shutdown) yield* releaseDevice(session.hostId, session.deviceId);
    else {
      const hold = yield* holdFor(session, yield* inner.state);
      if (hold) yield* release(hold);
    }
    yield* inner.close({
      threadId: session.threadId,
      hostId: session.hostId,
      deviceId: session.deviceId,
      ...(shutdown ? { shutdown } : {}),
    });
    if (shutdown) yield* poweredOff(session.hostId, session.deviceId);
    yield* markUsed(deviceKey(session.hostId, session.deviceId));
  });

  const close: DeviceService.DeviceService["Service"]["close"] = Effect.fn("DeviceIdle.close")(
    function* (input) {
      const closing = (yield* inner.state).sessions.filter(
        (session) =>
          session.threadId === input.threadId &&
          (input.hostId === undefined || session.hostId === input.hostId) &&
          (input.deviceId === undefined || session.deviceId === input.deviceId),
      );
      for (const session of closing)
        yield* closeOne(session, input.shutdown === true).pipe(
          withDevice(session.hostId, session.deviceId),
        );
    },
  );

  const shutdownUnlocked = Effect.fn("DeviceIdle.shutdown")(function* (input: DeviceShutdownInput) {
    const hostId = input.hostId ?? LOCAL_DEVICE_HOST_ID;
    yield* releaseDevice(hostId, input.deviceId);
    yield* inner.shutdown(input);
    yield* poweredOff(hostId, input.deviceId);
  });
  const shutdown: DeviceService.DeviceService["Service"]["shutdown"] = (input) =>
    shutdownUnlocked(input).pipe(withDevice(input.hostId ?? LOCAL_DEVICE_HOST_ID, input.deviceId));

  const activity: DeviceActivityShape = {
    watch: (hostId, deviceId) => {
      const key = deviceKey(hostId, deviceId);
      const adjust = (delta: number) =>
        Effect.suspend(() => {
          const count = (viewers.get(key) ?? 0) + delta;
          if (count > 0) viewers.set(key, count);
          else viewers.delete(key);
          return markUsed(key);
        });
      return Effect.acquireRelease(adjust(1), () => adjust(-1));
    },
    touchThreads: (match) =>
      inner.state.pipe(
        Effect.flatMap((state) =>
          Effect.forEach(
            state.sessions.filter((session) => match(session.threadId)),
            (session) => markUsed(deviceKey(session.hostId, session.deviceId)),
            { discard: true },
          ),
        ),
      ),
    notePeer: (threadPrefix, environmentId) => void peers.set(threadPrefix, environmentId),
    inUse: (threadId) => inner.state.pipe(Effect.flatMap((state) => inUseBy(threadId, state))),
  };

  /**
   * Shuts down devices this server booted that nobody has watched for
   * `shutdownAfter` and no working thread holds, releasing their claims first.
   */
  const sweep = Effect.fn("DeviceIdle.sweep")(function* (input: {
    readonly shutdownAfter: Duration.Duration | null;
    readonly agentAccess: boolean;
  }) {
    const state = yield* inner.state;
    // Holds outlive their sessions only when the service dropped them, as when device support
    // turns off; and turning agent access off stops the daemons and their claims.
    const live = new Set(
      state.sessions.map((session) => holdKey(session.threadId, session.hostId, session.deviceId)),
    );
    for (const key of holds.keys()) if (!live.has(key)) holds.delete(key);
    if (!input.agentAccess) unreleased.clear();

    // An archived or deleted thread can no longer use its devices. A thread that is not
    // in the projections yet may be a draft with an open Device panel, so only an
    // agent's hold counts it as deleted.
    for (const session of state.sessions) {
      if (session.threadId.startsWith(PEER_THREAD_PREFIX)) continue;
      // Decide under the device lock, so a thread unarchived and reopened while the
      // sweep waited keeps its new session.
      yield* Effect.gen(function* () {
        const current = yield* inner.state;
        if (
          !current.sessions.some(
            (candidate) =>
              candidate.threadId === session.threadId &&
              onDevice(session.hostId, session.deviceId)(candidate),
          )
        )
          return;
        const status = yield* options.threadStatus(session.threadId);
        if (status !== "archived" && !(status === "missing" && (yield* holdFor(session, current))))
          return;
        yield* closeOne(session, false);
        yield* Effect.logInfo("Released a device from a thread that ended", {
          threadId: session.threadId,
          hostId: session.hostId,
          deviceId: session.deviceId,
          status,
        });
      }).pipe(withDevice(session.hostId, session.deviceId));
    }

    const stopped: Array<DeviceShutdownInput> = [];
    if (input.shutdownAfter === null) return { stopped };
    const shutdownAfter = Duration.toMillis(input.shutdownAfter);
    yield* prune(state);
    /** A thread working on a device keeps it, and counts as use. */
    const kept = Effect.fn("DeviceIdle.kept")(function* (
      current: DeviceServiceState,
      hostId: string,
      deviceId: string,
    ) {
      for (const session of current.sessions.filter(onDevice(hostId, deviceId))) {
        const hold = yield* holdFor(session, current);
        if (
          hold &&
          !hold.threadId.startsWith(PEER_THREAD_PREFIX) &&
          (yield* threadBusy(hold.threadId))
        ) {
          yield* markUsed(deviceKey(hostId, deviceId));
          return true;
        }
      }
      return false;
    });
    for (const [key, record] of booted) {
      const stop = Effect.gen(function* () {
        if (viewers.has(key) || !booted.has(key)) return;
        if (yield* kept(yield* inner.state, record.hostId, record.deviceId)) return;
        if ((yield* idleFor(key)) < shutdownAfter) return;
        // The local hub is cheap to start, and is not running after a restart. Only use a
        // remote host that is already up: probing an offline SSH host would reconnect it.
        const local =
          record.hostId === LOCAL_DEVICE_HOST_ID ||
          (yield* inner.state).hosts.find((host) => host.id === record.hostId)?.kind === "local";
        const ready = local
          ? yield* inner.readiness(record.hostId).pipe(Effect.orElseSucceed(() => null))
          : yield* inner.currentReadiness(record.hostId);
        if (!ready) return;
        // Re-read the host so a device shut down or replaced outside styal is dropped first.
        const listed = yield* inner.listHost(record.hostId).pipe(Effect.result);
        if (listed._tag === "Failure") return;
        yield* prune(listed.success);
        if (!booted.has(key) || viewers.has(key)) return;
        if (yield* kept(listed.success, record.hostId, record.deviceId)) return;
        if ((yield* idleFor(key)) < shutdownAfter) return;
        const target = {
          hostId: record.hostId,
          deviceId: record.deviceId,
          platform: record.platform,
        };
        const result = yield* shutdownUnlocked(target).pipe(Effect.result);
        if (result._tag === "Success") {
          yield* Effect.logInfo("Shut down idle device", target);
          stopped.push(target);
        } else {
          // Wait another full idle period before retrying a device that refused to stop.
          yield* markUsed(key);
          yield* Effect.logWarning("Could not shut down idle device", {
            ...target,
            error: result.failure.message,
          });
        }
      });
      yield* stop.pipe(withDevice(record.hostId, record.deviceId));
    }
    return { stopped };
  });

  return {
    service: DeviceService.DeviceService.of({
      ...inner,
      agentTarget,
      open,
      close,
      shutdown,
    }),
    activity,
    sweep,
  };
});

const live = Layer.effectContext(
  Effect.gen(function* () {
    const inner = yield* DeviceService.DeviceService;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    const environment = yield* ServerEnvironment.ServerEnvironment;

    const ledgerPath = path.join(config.stateDir, "device", "booted-devices.json");
    const releasedPath = releasedAgentSessionsPath(config.stateDir, path);
    const releasedCodec = Schema.fromJsonString(Schema.Array(Schema.String));
    const codec = Schema.fromJsonString(DeviceBootRecords);
    const ledgerLock = yield* Semaphore.make(1);
    const idle = yield* make(inner, {
      environmentId: yield* environment.getEnvironmentId,
      releasedSessions: {
        load: fs.readFileString(releasedPath).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(releasedCodec)),
          Effect.orElseSucceed(() => []),
        ),
        save: (names) =>
          Schema.encodeEffect(releasedCodec)(names).pipe(
            Effect.flatMap((contents) =>
              writeFileStringAtomically({ filePath: releasedPath, contents }),
            ),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.catch((cause) =>
              Effect.logWarning("Could not save the released device sessions", { cause }),
            ),
          ),
      },
      memoryModeForThread: Effect.fn("DeviceIdle.memoryModeForThread")(
        function* (input) {
          const thread = yield* projections.getThreadShell(input.threadId);
          const current = yield* settings.getSettings;
          return resolveProjectSettings(current, thread?.projectId ?? input.projectId ?? null)
            .settings.simulatorMemoryMode;
        },
        (effect) =>
          effect.pipe(
            Effect.mapError(
              (cause) =>
                new DeviceOperationError({
                  operation: "read project memory mode",
                  reason: "settings_failed",
                  cause,
                }),
            ),
          ),
      ),
      // An unreadable projection keeps the device.
      threadStatus: (threadId) =>
        projections.getThreadShell(threadId).pipe(
          Effect.map(threadStatus),
          Effect.orElseSucceed((): DeviceThreadStatus => "working"),
        ),
      ledger: {
        load: fs.readFileString(ledgerPath).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(codec)),
          Effect.orElseSucceed(() => []),
        ),
        save: (records) =>
          Schema.encodeEffect(codec)(records).pipe(
            Effect.flatMap((contents) =>
              writeFileStringAtomically({ filePath: ledgerPath, contents }),
            ),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            ledgerLock.withPermit,
            Effect.catch((cause) =>
              Effect.logWarning("Could not save the devices this server booted", { cause }),
            ),
          ),
      },
      // The local daemon is supervised here, so a stopped one holds nothing. Other hosts
      // are reached through the endpoint written when an agent last targeted them.
      agentEndpoint: (hostId, deviceId) =>
        hostId === LOCAL_DEVICE_HOST_ID
          ? inner.currentAgentEndpoint(hostId)
          : readAgentDeviceConfig(config.stateDir, hostId, deviceId).pipe(
              Effect.map((saved): AgentDeviceEndpoint | null =>
                saved ? { ...saved, entryPath: "" } : null,
              ),
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.provideService(Crypto.Crypto, crypto),
            ),
    });

    const sweep = Effect.gen(function* () {
      const current = yield* settings.getSettings;
      if (!current.enableDeviceSupport) return;
      yield* idle.sweep({
        shutdownAfter:
          current.deviceIdleShutdownMinutes === null
            ? null
            : Duration.minutes(current.deviceIdleShutdownMinutes),
        agentAccess: current.enableAgentDeviceAccess,
      });
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("Idle device sweep failed", { cause }),
      ),
    );
    yield* forkParked(sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))));

    return Context.make(DeviceService.DeviceService, idle.service).pipe(
      Context.add(DeviceActivity, idle.activity),
    );
  }),
).pipe(Layer.provide(ProjectionStore.layer));

/** Puts on-demand hand-back and idle shutdown in front of a device service layer. */
export const wrap = <E, R>(inner: Layer.Layer<DeviceService.DeviceService, E, R>) =>
  live.pipe(Layer.provide(inner));
