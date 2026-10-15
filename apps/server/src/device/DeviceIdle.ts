/**
 * Hands idle devices back and shuts down the ones nobody holds, so agents
 * sharing a machine's simulators and emulators take turns instead of keeping
 * every device they ever opened.
 *
 * An agent holds a device through two records: the service's session and the
 * agent-device session `device_open` handed out, whose device claim stops other
 * threads from driving it. The daemon owning that claim never exits while the
 * server runs, so nothing else releases it. Closing a device releases both; a
 * hold left idle is released after `RELEASE_AFTER`. A device this server
 * booted that no agent holds and nobody watches shuts down after
 * `deviceIdleShutdownMinutes`; devices booted outside styal are never shut down.
 *
 * Sessions the user opened from the Device panel carry no claim and are never
 * released here. Lives beside `DeviceService` rather than inside it: the layer
 * wraps the service's lifecycle methods and drives everything else through its
 * public interface.
 */
import {
  DeviceHostId,
  DeviceId,
  DevicePlatform,
  type DeviceServiceState,
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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { agentDeviceConfigPath, agentDeviceSession } from "./AgentDeviceTarget.ts";
import type { AgentDeviceEndpoint } from "./DeviceHost.ts";
import * as DeviceService from "./DeviceService.ts";
import { environmentDeviceHostId } from "./EnvironmentDeviceHost.ts";

const SWEEP_INTERVAL = Duration.minutes(1);
/** Matches what agent-device's own help tells agents about stale leases. */
const RELEASE_AFTER = Duration.minutes(5);
const RELEASE_TIMEOUT = Duration.seconds(15);
/** A claim that still will not release after this many sweeps is left to the daemon. */
const RELEASE_ATTEMPTS = 3;
/** Sessions a connected environment opened here; that environment releases them when idle. */
const PEER_THREAD_PREFIX = "device-peer-";

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
}

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

/** An agent's hold on a device: the thread and the agent-device session names it may use. */
interface Hold {
  readonly threadId: ThreadId;
  readonly hostId: DeviceHostId;
  readonly deviceId: DeviceId;
  readonly names: ReadonlyArray<string>;
}

/** A hold whose session was dropped. Watched until its claim is known to be released. */
interface Released extends Hold {
  /** The claim may still be held: the release failed, or the thread worked again since. */
  retry: boolean;
  attempts: number;
}

const deviceKey = (hostId: string, deviceId: string) => JSON.stringify([hostId, deviceId]);
const holdKey = (threadId: string, hostId: string, deviceId: string) =>
  JSON.stringify([threadId, hostId, deviceId]);
const onDevice = (hostId: string, deviceId: string) => (entry: Pick<Hold, "hostId" | "deviceId">) =>
  entry.hostId === hostId && entry.deviceId === deviceId;

/** A thread still working may drive its devices at any moment. */
const threadKeepsDevices = (thread: OrchestrationV2ThreadShell) =>
  thread.activeRunId !== null || (thread.pendingBackgroundTasks?.length ?? 0) > 0;

export const make = Effect.fn("DeviceIdle.make")(function* (
  inner: DeviceService.DeviceService["Service"],
  options: {
    readonly ledger: DeviceBootLedger;
    /** The agent-device daemon agents on this host use, or null when none can hold claims. */
    readonly agentEndpoint: (hostId: DeviceHostId) => Effect.Effect<AgentDeviceEndpoint | null>;
    /** This environment's id, which connected environments use to name their claims here. */
    readonly environmentId: string;
  },
) {
  const { ledger } = options;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const booted = new Map(
    (yield* ledger.load).map((record) => [deviceKey(record.hostId, record.deviceId), record]),
  );
  // Idle time counts from server start for devices from before a restart.
  const startedAt = yield* Clock.currentTimeMillis;
  const lastUsedAt = new Map<string, number>();
  const viewers = new Map<string, number>();
  /** agent-device session names handed out by `agentTarget`, keyed by the device id asked for. */
  const targeted = new Map<string, string>();
  const holds = new Map<string, Hold>();
  const released = new Map<string, Released>();
  const peers = new Map<string, string>();
  const locks = new Map<string, Semaphore.Semaphore>();

  /** Serializes lifecycle work on one device so a reopen cannot interleave with a release. */
  const withDevice = (hostId: string, deviceId: string) => {
    const key = deviceKey(hostId, deviceId);
    let lock = locks.get(key);
    if (!lock) locks.set(key, (lock = Semaphore.makeUnsafe(1)));
    return lock.withPermit;
  };
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
  const holdFor = (session: DeviceSession, state: DeviceServiceState): Hold | undefined => {
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
      names: ids.map((id) =>
        agentDeviceSession(
          `${environmentId}:${session.threadId.slice(separator + 1)}`,
          environmentDeviceHostId(options.environmentId),
          id,
        ),
      ),
    };
  };

  /** Ends the hold's agent-device sessions. Succeeds when none is left on the daemon. */
  const releaseClaim = Effect.fn("DeviceIdle.releaseClaim")(function* (hold: Hold) {
    // The hold's host serves peer sessions through this environment's own daemon.
    const endpoint = yield* options.agentEndpoint(
      hold.threadId.startsWith(PEER_THREAD_PREFIX) ? LOCAL_DEVICE_HOST_ID : hold.hostId,
    );
    // No daemon means no claims: they belong to the daemon that is gone.
    if (!endpoint) return;
    for (const name of hold.names) {
      const reply = yield* HttpClientRequest.post(`${endpoint.baseUrl}/rpc`).pipe(
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
      );
      // A session no command used again is already gone.
      if ("result" in reply ? !reply.result.ok : reply.error.data?.code !== "SESSION_NOT_FOUND")
        return yield* Effect.fail(reply);
    }
  });

  /** Releases a hold, keeping it for the sweep to retry when the daemon does not answer. */
  const release = (hold: Hold) =>
    releaseClaim(hold).pipe(
      Effect.result,
      Effect.flatMap((result) => {
        const key = holdKey(hold.threadId, hold.hostId, hold.deviceId);
        holds.delete(key);
        const retry = result._tag === "Failure";
        released.set(key, { ...hold, retry, attempts: retry ? 1 : 0 });
        return retry
          ? Effect.logWarning("Could not release device; will retry", {
              threadId: hold.threadId,
              hostId: hold.hostId,
              deviceId: hold.deviceId,
              cause: result.failure,
            })
          : Effect.void;
      }),
    );

  /** Releases every claim on a device before it powers off; one held on a powered-off device never clears. */
  const releaseDevice = Effect.fn("DeviceIdle.releaseDevice")(function* (
    hostId: string,
    deviceId: string,
  ) {
    const state = yield* inner.state;
    for (const session of state.sessions.filter(onDevice(hostId, deviceId))) {
      const hold = holdFor(session, state);
      if (hold) yield* release(hold);
    }
    for (const entry of [...released.values()].filter(onDevice(hostId, deviceId))) {
      if (entry.retry) yield* release(entry);
    }
  });

  const poweredOff = (hostId: string, deviceId: string) =>
    Effect.suspend(() => {
      for (const [key, entry] of released)
        if (onDevice(hostId, deviceId)(entry) && !entry.retry) released.delete(key);
      return forget([deviceKey(hostId, deviceId)]);
    });

  const agentTarget: DeviceService.DeviceService["Service"]["agentTarget"] = (input) =>
    inner.agentTarget(input).pipe(
      Effect.tap((args) =>
        Effect.sync(() => {
          const name = args[args.indexOf("--session") + 1];
          if (name) targeted.set(holdKey(input.threadId, input.hostId, input.deviceId), name);
        }),
      ),
    );

  // The service publishes a booting entry only when it boots the device itself.
  const open: DeviceService.DeviceService["Service"]["open"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* inner.subscribe;
        const session = yield* inner.open(input);
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
        const asked = holdKey(input.threadId, session.hostId, input.deviceId);
        const name = targeted.get(asked);
        if (name) {
          targeted.delete(asked);
          const opened = holdKey(session.threadId, session.hostId, session.deviceId);
          released.delete(opened);
          holds.set(opened, {
            threadId: session.threadId,
            hostId: session.hostId,
            deviceId: session.deviceId,
            names: [name],
          });
        }
        yield* markUsed(key);
        return session;
      }),
    ).pipe(withDevice(input.hostId ?? LOCAL_DEVICE_HOST_ID, input.deviceId));

  const closeOne = Effect.fn("DeviceIdle.closeOne")(function* (
    session: DeviceSession,
    shutdown: boolean,
  ) {
    if (shutdown) yield* releaseDevice(session.hostId, session.deviceId);
    else {
      const hold = holdFor(session, yield* inner.state);
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
  };

  /**
   * Hands back agent holds idle for `RELEASE_AFTER`, retries claims that did not
   * release, then shuts down devices this server booted that no agent holds and
   * nobody has watched for `shutdownAfter`. A thread still working keeps its devices.
   */
  const sweep = Effect.fn("DeviceIdle.sweep")(function* (input: {
    readonly shutdownAfter: Duration.Duration | null;
    readonly agentAccess: boolean;
    readonly threadBusy: (threadId: ThreadId) => Effect.Effect<boolean>;
  }) {
    const handedBack: Array<DeviceSession> = [];
    for (const session of (yield* inner.state).sessions) {
      if (session.threadId.startsWith(PEER_THREAD_PREFIX)) continue;
      const key = holdKey(session.threadId, session.hostId, session.deviceId);
      if (!holds.has(key)) continue;
      const device = deviceKey(session.hostId, session.deviceId);
      const idle = Effect.gen(function* () {
        // Re-check under the lock: the thread may have reopened or a viewer attached.
        const current = (yield* inner.state).sessions.find(
          (candidate) => holdKey(candidate.threadId, candidate.hostId, candidate.deviceId) === key,
        );
        const hold = holds.get(key);
        if (!current || !hold || viewers.has(device)) return false;
        if (yield* input.threadBusy(session.threadId)) {
          yield* markUsed(device);
          return false;
        }
        if ((yield* idleFor(device)) < Duration.toMillis(RELEASE_AFTER)) return false;
        yield* closeOne(current, false);
        return true;
      });
      if (yield* idle.pipe(withDevice(session.hostId, session.deviceId))) {
        yield* Effect.logInfo("Released idle device", session);
        handedBack.push(session);
      }
    }

    // Agent access off stops the daemons, and their claims with them.
    if (!input.agentAccess) released.clear();
    for (const [key, entry] of released) {
      const device = deviceKey(entry.hostId, entry.deviceId);
      // A released thread can still drive the device by its selector; work since the release keeps it.
      if (yield* input.threadBusy(entry.threadId)) {
        entry.retry = true;
        yield* markUsed(device);
        continue;
      }
      if (!entry.retry || (yield* idleFor(device)) < Duration.toMillis(RELEASE_AFTER)) continue;
      const result = yield* releaseClaim(entry).pipe(Effect.result);
      if (result._tag === "Success") {
        entry.retry = false;
        entry.attempts = 0;
      } else if (++entry.attempts >= RELEASE_ATTEMPTS) {
        released.delete(key);
        yield* Effect.logWarning("Giving up releasing device", {
          threadId: entry.threadId,
          hostId: entry.hostId,
          deviceId: entry.deviceId,
          cause: result.failure,
        });
      }
    }

    const stopped: Array<DeviceShutdownInput> = [];
    if (input.shutdownAfter === null) return { handedBack, stopped };
    const shutdownAfter = Duration.toMillis(input.shutdownAfter);
    yield* prune(yield* inner.state);
    const heldOrWorking = Effect.fn("DeviceIdle.heldOrWorking")(function* (
      state: DeviceServiceState,
      hostId: string,
      deviceId: string,
    ) {
      if (
        state.sessions.some(
          (session) => onDevice(hostId, deviceId)(session) && holdFor(session, state),
        )
      )
        return true;
      for (const entry of released.values())
        if (onDevice(hostId, deviceId)(entry) && (yield* input.threadBusy(entry.threadId)))
          return true;
      return false;
    });
    for (const [key, record] of booted) {
      const stop = Effect.gen(function* () {
        if (viewers.has(key) || !booted.has(key)) return false;
        if (yield* heldOrWorking(yield* inner.state, record.hostId, record.deviceId)) return false;
        if ((yield* idleFor(key)) < shutdownAfter) return false;
        // The local hub is cheap to start, and is not running after a restart. Only use a
        // remote host that is already up: probing an offline SSH host would reconnect it.
        const local =
          record.hostId === LOCAL_DEVICE_HOST_ID ||
          (yield* inner.state).hosts.find((host) => host.id === record.hostId)?.kind === "local";
        const ready = local
          ? yield* inner.readiness(record.hostId).pipe(Effect.orElseSucceed(() => null))
          : yield* inner.currentReadiness(record.hostId);
        if (!ready) return false;
        // Re-read the host so a device shut down or replaced outside styal is dropped first.
        const listed = yield* inner.listHost(record.hostId).pipe(Effect.result);
        if (listed._tag === "Failure") return false;
        yield* prune(listed.success);
        if (!booted.has(key) || viewers.has(key)) return false;
        if (yield* heldOrWorking(listed.success, record.hostId, record.deviceId)) return false;
        if ((yield* idleFor(key)) < shutdownAfter) return false;
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
        return true;
      });
      yield* stop.pipe(withDevice(record.hostId, record.deviceId));
    }
    return { handedBack, stopped };
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

const AgentDeviceConfig = Schema.fromJsonString(
  Schema.Struct({ daemonBaseUrl: Schema.String, daemonAuthToken: Schema.String }),
);

const live = Layer.effectContext(
  Effect.gen(function* () {
    const inner = yield* DeviceService.DeviceService;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    const environment = yield* ServerEnvironment.ServerEnvironment;

    const ledgerPath = path.join(config.stateDir, "device", "booted-devices.json");
    const codec = Schema.fromJsonString(DeviceBootRecords);
    const ledgerLock = yield* Semaphore.make(1);
    const idle = yield* make(inner, {
      environmentId: yield* environment.getEnvironmentId,
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
      agentEndpoint: (hostId) =>
        hostId === LOCAL_DEVICE_HOST_ID
          ? inner.currentAgentEndpoint(hostId)
          : fs.readFileString(agentDeviceConfigPath(config.stateDir, hostId, path)).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(AgentDeviceConfig)),
              Effect.map((saved): AgentDeviceEndpoint => ({
                baseUrl: saved.daemonBaseUrl,
                token: saved.daemonAuthToken,
                entryPath: "",
              })),
              Effect.orElseSucceed(() => null),
            ),
    });

    // An unreadable projection keeps the device.
    const threadBusy = (threadId: ThreadId) =>
      projections.getThreadShell(threadId).pipe(
        Effect.map((thread) => thread !== null && threadKeepsDevices(thread)),
        Effect.orElseSucceed(() => true),
      );
    const sweep = Effect.gen(function* () {
      const current = yield* settings.getSettings;
      if (!current.enableDeviceSupport) return;
      yield* idle.sweep({
        shutdownAfter:
          current.deviceIdleShutdownMinutes === null
            ? null
            : Duration.minutes(current.deviceIdleShutdownMinutes),
        agentAccess: current.enableAgentDeviceAccess,
        threadBusy,
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

/** Puts idle hand-back and shutdown in front of a device service layer. */
export const wrap = <E, R>(inner: Layer.Layer<DeviceService.DeviceService, E, R>) =>
  live.pipe(Layer.provide(inner));
