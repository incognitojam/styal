/**
 * HardwareService - network devices that agents lease and call through the
 * server.
 *
 * One thread holds a device at a time. `read` actions need no lease;
 * `operate` actions need the caller to hold it; `approve` actions also wait
 * for the user, through the same approval card a provider approval uses.
 * Every way a lease ends runs the definition's release hooks, so a crashed
 * calibration run does not leave the device in calibration mode.
 *
 * A lease survives turns: a busy thread keeps it, and an idle one keeps it
 * for `idleMinutes` after its last activity, up to a hard cap the user can
 * lift. Scripts reach the device through a loopback proxy URL whose token
 * dies with the lease.
 *
 * The device's own API usually accepts anyone on the network, so until its
 * firmware requires the credential stored here, the lease only holds while
 * agents use these paths.
 *
 * @module HardwareService
 */
import {
  CommandId,
  HARDWARE_DEFINITION_DIRECTORY,
  type HardwareActionDefinition,
  type HardwareAuditListInput,
  type HardwareAuditListResult,
  type HardwareDefinition,
  type HardwareDeviceConfig,
  type HardwareDeviceId,
  type HardwareDeviceState,
  HardwareError,
  type HardwareHealth,
  type HardwareHookStep,
  type HardwareServiceState,
  type HardwareConfigureInput,
  type HardwareControlInput,
  type HardwareToolAcquireInput,
  type HardwareToolAcquireResult,
  type HardwareToolCallInput,
  type HardwareToolCallResult,
  type HardwareToolDevice,
  HardwareToolError,
  type HardwareToolErrorCode,
  type OrchestrationV2ThreadShell,
  type ProviderApprovalDecision,
  RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- random tokens and file hashes.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { VcsProcess } from "../vcs/VcsProcess.ts";
import {
  actionForRequest,
  type EffectiveDefinition,
  effectiveDefinition,
  parseDefinition,
  refusedQueryKeys,
  summarizeActions,
  withWorktreeOverlay,
} from "./HardwareDefinition.ts";
import * as HardwareStore from "./HardwareStore.ts";

const TICK_INTERVAL = Duration.seconds(15);
const DEFAULT_HEALTH_INTERVAL_MS = 30_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const DEFINITION_RELOAD_MS = 60_000;
const FETCH_THROTTLE_MS = 5 * 60_000;
const DEFAULT_IDLE_MINUTES = 30;
const HARD_CAP_MS = 8 * 60 * 60_000;
const DEFAULT_WAIT_MINUTES = 10;
const DEFAULT_DEVICE_TTL_SECONDS = 180;
const DEFAULT_RENEW_EVERY_MS = 60_000;
const ACTIVITY_WRITE_INTERVAL_MS = 30_000;
const APPROVAL_TIMEOUT = Duration.minutes(10);
const APPROVAL_POLL_INTERVAL = Duration.millis(500);
const RELEASE_RETRY_WINDOW_MS = 10 * 60_000;
const RELEASE_RETRY_INTERVAL = Duration.seconds(30);
const CALL_TIMEOUT = Duration.seconds(15);
const UPLOAD_TIMEOUT = Duration.seconds(90);
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_CHARS = 64 * 1024;
const PROXY_PATH_PREFIX = "/api/hardware/proxy";

const secretName = (deviceId: HardwareDeviceId) => `hardware-device-${deviceId}`;

interface Lease extends HardwareStore.StoredLease {
  /** Actions the user allowed for the rest of this lease. */
  readonly approvedActions: ReadonlySet<string>;
  readonly lastPersistedActivityAt: number;
  readonly lastRenewHookAt: number;
}

interface Waiter {
  readonly threadId: ThreadId;
  readonly queuedAt: number;
}

interface DefinitionState {
  readonly loadedAt: number;
  readonly source: string | null;
  readonly main: HardwareDefinition | null;
  readonly error: string | undefined;
  readonly missing: boolean;
}

interface DeviceRuntime {
  readonly health: HardwareHealth;
  readonly lastProbeAt: number;
  readonly definition: DefinitionState | null;
  readonly paused: boolean;
}

interface ProxiedRequest {
  readonly token: string;
  readonly method: string;
  readonly path: string;
  readonly query: ReadonlyArray<readonly [string, string]>;
}

export interface ProxiedResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: Uint8Array | string;
}

export class HardwareService extends Context.Service<
  HardwareService,
  {
    readonly state: Effect.Effect<HardwareServiceState>;
    /** Current state first, then every change. Probes device health while subscribed. */
    readonly stateStream: Stream.Stream<HardwareServiceState>;
    readonly listForThread: (
      threadId: ThreadId,
      device?: HardwareDeviceId,
    ) => Effect.Effect<ReadonlyArray<HardwareToolDevice>, HardwareToolError>;
    readonly acquire: (
      threadId: ThreadId,
      input: HardwareToolAcquireInput,
    ) => Effect.Effect<HardwareToolAcquireResult, HardwareToolError>;
    readonly call: (
      threadId: ThreadId,
      input: HardwareToolCallInput,
    ) => Effect.Effect<HardwareToolCallResult, HardwareToolError>;
    readonly release: (
      threadId: ThreadId,
      device: HardwareDeviceId,
    ) => Effect.Effect<{ readonly released: boolean }, HardwareToolError>;
    readonly proxy: (request: ProxiedRequest) => Effect.Effect<ProxiedResponse>;
    /** Revoke, pause or keep a lease. */
    readonly control: (input: HardwareControlInput) => Effect.Effect<void, HardwareError>;
    /** Accept the default branch's definition, or store or clear the device credential. */
    readonly configure: (input: HardwareConfigureInput) => Effect.Effect<void, HardwareError>;
    readonly auditList: (
      input: HardwareAuditListInput,
    ) => Effect.Effect<HardwareAuditListResult, HardwareError>;
  }
>()("@styal/cli/hardware/HardwareService") {}

const toolError = (code: HardwareToolErrorCode, reason: string) =>
  new HardwareToolError({ code, reason });

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const threadBusy = (shell: OrchestrationV2ThreadShell | null) =>
  shell !== null && (shell.activeRunId !== null || (shell.pendingBackgroundTasks?.length ?? 0) > 0);

const threadGone = (shell: OrchestrationV2ThreadShell | null) =>
  shell === null || shell.deletedAt != null || shell.archivedAt != null;

/** Reads `a.b.c` out of a JSON value, for the health summary line. */
const readPath = (value: unknown, path: string): unknown => {
  let current = value;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

const fillTemplate = (value: string, lease: { purpose: string }, ttl: number) =>
  value
    .replaceAll("$lease.purpose", lease.purpose)
    .replaceAll("$lease.deviceTtlSeconds", String(ttl));

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownOption(UnknownFromJsonString);
const encodeJson = Schema.encodeSync(UnknownFromJsonString);

const decodeBody = (bytes: Uint8Array, contentType: string | null) => {
  const text = new TextDecoder().decode(bytes);
  const truncated = text.length > MAX_RESPONSE_CHARS;
  const clipped = truncated ? text.slice(0, MAX_RESPONSE_CHARS) : text;
  if (!truncated && (contentType?.includes("json") || /^\s*[[{]/.test(clipped))) {
    const parsed = decodeJson(clipped);
    if (Option.isSome(parsed)) return { body: parsed.value, truncated };
  }
  return { body: clipped, truncated };
};

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const vcs = yield* VcsProcess;
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* HardwareStore.HardwareStore;
  const config = yield* ServerConfig.ServerConfig;
  const scope = yield* Effect.scope;

  const leases = yield* Ref.make(new Map<HardwareDeviceId, Lease>());
  const queues = yield* Ref.make(new Map<HardwareDeviceId, ReadonlyArray<Waiter>>());
  const runtime = yield* Ref.make(new Map<HardwareDeviceId, DeviceRuntime>());
  const credentialPresent = yield* Ref.make(new Map<HardwareDeviceId, boolean>());
  const lastFetchAt = yield* Ref.make(new Map<string, number>());
  const subscribers = yield* Ref.make(0);
  const updates = yield* PubSub.sliding<HardwareServiceState>(16);
  /** Swapped on every lease change; waiters re-check when it completes. */
  const leaseChanged = yield* Ref.make(yield* Deferred.make<void>());
  /** One lease decision per device at a time. */
  const deviceLocks = new Map<HardwareDeviceId, Semaphore.Semaphore>();
  const lockFor = (deviceId: HardwareDeviceId) => {
    let lock = deviceLocks.get(deviceId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      deviceLocks.set(deviceId, lock);
    }
    return lock;
  };

  const proxyHost =
    config.host === undefined || config.host === "0.0.0.0" || config.host === "::"
      ? "127.0.0.1"
      : config.host.includes(":")
        ? `[${config.host}]`
        : config.host;
  const proxyBaseUrl = (token: string) =>
    `http://${proxyHost}:${config.port}${PROXY_PATH_PREFIX}/${token}`;

  const devices = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.hardwareDevices),
    Effect.orElseSucceed((): ReadonlyArray<HardwareDeviceConfig> => []),
  );
  const findDevice = (deviceId: HardwareDeviceId) =>
    Effect.map(devices, (list) => list.find((device) => device.id === deviceId));

  const getShell = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));

  const runtimeFor = (deviceId: HardwareDeviceId) =>
    Effect.map(
      Ref.get(runtime),
      (map): DeviceRuntime =>
        map.get(deviceId) ?? {
          health: { status: "unknown", checkedAt: null, lastSeenAt: null, summary: null },
          lastProbeAt: 0,
          definition: null,
          paused: false,
        },
    );
  const updateRuntime = (
    deviceId: HardwareDeviceId,
    update: (current: DeviceRuntime) => DeviceRuntime,
  ) =>
    Effect.flatMap(runtimeFor(deviceId), (current) =>
      Ref.update(runtime, (map) => new Map(map).set(deviceId, update(current))),
    );

  // Definitions

  const git = (cwd: string, args: ReadonlyArray<string>, timeoutMs = 10_000) =>
    vcs
      .run({
        operation: "HardwareService.git",
        command: "git",
        args,
        cwd,
        allowNonZeroExit: true,
        timeoutMs,
      })
      .pipe(Effect.option);

  /** `origin`'s default branch when there is a remote, else the local default branch. */
  const definitionRef = Effect.fn("HardwareService.definitionRef")(function* (root: string) {
    const head = yield* git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const candidates = [
      ...(Option.isSome(head) && head.value.exitCode === 0 ? [head.value.stdout.trim()] : []),
      "origin/main",
      "origin/master",
    ];
    const hasOrigin = Option.isSome(
      yield* git(root, ["remote", "get-url", "origin"]).pipe(
        Effect.map(Option.filter((result) => result.exitCode === 0)),
      ),
    );
    if (!hasOrigin) candidates.push("main", "master");
    for (const ref of candidates) {
      if (ref.length === 0) continue;
      const verified = yield* git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      if (Option.isSome(verified) && verified.value.exitCode === 0) return ref;
    }
    return null;
  });

  const maybeFetch = Effect.fn("HardwareService.maybeFetch")(function* (root: string) {
    const now = yield* Clock.currentTimeMillis;
    const last = (yield* Ref.get(lastFetchAt)).get(root) ?? 0;
    if (now - last < FETCH_THROTTLE_MS) return;
    yield* Ref.update(lastFetchAt, (map) => new Map(map).set(root, now));
    yield* git(root, ["fetch", "--quiet", "origin"], 30_000);
  });

  const projectRoot = (device: HardwareDeviceConfig) =>
    projects.getById(device.projectId).pipe(
      Effect.map(Option.map((project) => project.workspaceRoot)),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  const loadDefinition = Effect.fn("HardwareService.loadDefinition")(function* (
    device: HardwareDeviceConfig,
    options: { readonly fetch?: boolean; readonly force?: boolean } = {},
  ) {
    const current = yield* runtimeFor(device.id);
    const now = yield* Clock.currentTimeMillis;
    if (
      !options.force &&
      !options.fetch &&
      current.definition !== null &&
      now - current.definition.loadedAt < DEFINITION_RELOAD_MS
    ) {
      return current.definition;
    }
    const root = yield* projectRoot(device);
    const loaded: DefinitionState = yield* Effect.gen(function* () {
      if (Option.isNone(root)) {
        return {
          loadedAt: now,
          source: null,
          main: null,
          error: "The project is missing.",
          missing: true,
        };
      }
      if (options.fetch) yield* maybeFetch(root.value);
      const ref = yield* definitionRef(root.value);
      if (ref === null) {
        return {
          loadedAt: now,
          source: null,
          main: null,
          error: "No default branch found.",
          missing: true,
        };
      }
      const file = `${HARDWARE_DEFINITION_DIRECTORY}/${device.definitionFile}`;
      const shown = yield* git(root.value, ["show", `${ref}:${file}`]);
      if (Option.isNone(shown) || shown.value.exitCode !== 0) {
        return {
          loadedAt: now,
          source: ref,
          main: null,
          error: `${file} is not on ${ref}.`,
          missing: true,
        };
      }
      const parsed = parseDefinition(shown.value.stdout);
      return "definition" in parsed
        ? { loadedAt: now, source: ref, main: parsed.definition, error: undefined, missing: false }
        : { loadedAt: now, source: ref, main: null, error: parsed.error, missing: false };
    });
    yield* updateRuntime(device.id, (state) => ({ ...state, definition: loaded }));
    return loaded;
  });

  const effectiveFor = (device: HardwareDeviceConfig, definition: DefinitionState | null) =>
    definition?.main == null
      ? null
      : effectiveDefinition(definition.main, device.acceptedDefinition);

  /** The worktree's own copy, for threads working on a branch that changes the device. */
  const worktreeOverlay = Effect.fn("HardwareService.worktreeOverlay")(function* (
    device: HardwareDeviceConfig,
    shell: OrchestrationV2ThreadShell,
  ) {
    if (shell.worktreePath === null) return undefined;
    const file = path.join(
      shell.worktreePath,
      HARDWARE_DEFINITION_DIRECTORY,
      device.definitionFile,
    );
    const text = yield* fs.readFileString(file).pipe(Effect.option);
    if (Option.isNone(text)) return undefined;
    const parsed = parseDefinition(text.value);
    return "definition" in parsed ? parsed.definition : undefined;
  });

  const actionsForThread = Effect.fn("HardwareService.actionsForThread")(function* (
    device: HardwareDeviceConfig,
    shell: OrchestrationV2ThreadShell,
    effective: EffectiveDefinition,
  ) {
    return withWorktreeOverlay(effective.actions, yield* worktreeOverlay(device, shell));
  });

  // Snapshots

  const deviceState = Effect.fn("HardwareService.deviceState")(function* (
    device: HardwareDeviceConfig,
  ) {
    const state = yield* runtimeFor(device.id);
    const lease = (yield* Ref.get(leases)).get(device.id);
    const queue = (yield* Ref.get(queues)).get(device.id) ?? [];
    const effective = effectiveFor(device, state.definition);
    const shell = lease === undefined ? null : yield* getShell(lease.threadId);
    const busy = threadBusy(shell);
    const definition = state.definition;
    const status: HardwareDeviceState["definition"]["status"] =
      definition === null || definition.missing
        ? "missing"
        : definition.main === null
          ? "invalid"
          : (effective?.pendingChanges.length ?? 0) > 0
            ? "pending"
            : "ok";
    return {
      id: device.id,
      name: definition?.main?.name ?? device.acceptedDefinition?.name ?? device.id,
      projectId: device.projectId,
      baseUrl: device.baseUrl,
      health: state.health,
      lease:
        lease === undefined
          ? null
          : {
              threadId: lease.threadId,
              purpose: lease.purpose,
              grantedAt: iso(lease.grantedAt),
              lastActivityAt: iso(lease.lastActivityAt),
              idleExpiresAt:
                busy || lease.keepUntilReleased
                  ? null
                  : iso(lease.lastActivityAt + lease.idleMinutes * 60_000),
              hardExpiresAt: lease.hardExpiresAt === null ? null : iso(lease.hardExpiresAt),
              keepUntilReleased: lease.keepUntilReleased,
            },
      queue: queue.map((waiter) => ({ threadId: waiter.threadId, queuedAt: iso(waiter.queuedAt) })),
      paused: state.paused,
      hasCredential: (yield* Ref.get(credentialPresent)).get(device.id) ?? false,
      definition: {
        status,
        source: definition?.source ?? null,
        ...(definition?.error === undefined ? {} : { error: definition.error }),
        pendingChanges: effective?.pendingChanges ?? [],
      },
      actions: effective === null ? [] : summarizeActions(effective.actions),
    } satisfies HardwareDeviceState;
  });

  const state: HardwareService["Service"]["state"] = Effect.gen(function* () {
    return { devices: yield* Effect.forEach(yield* devices, deviceState) };
  });

  const publish = Effect.flatMap(state, (snapshot) => PubSub.publish(updates, snapshot)).pipe(
    Effect.asVoid,
  );

  const notifyLeaseChanged = Effect.gen(function* () {
    const next = yield* Deferred.make<void>();
    const previous = yield* Ref.getAndSet(leaseChanged, next);
    yield* Deferred.succeed(previous, undefined);
    yield* publish;
  });

  // Device requests

  const credentialHeaders = Effect.fn("HardwareService.credentialHeaders")(function* (
    device: HardwareDeviceConfig,
  ) {
    const value = yield* secrets
      .get(secretName(device.id))
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(value)) return {};
    const token = new TextDecoder().decode(value.value);
    const header = device.auth?.header ?? "Authorization";
    const scheme =
      device.auth?.scheme ?? (header.toLowerCase() === "authorization" ? "Bearer" : undefined);
    return { [header.toLowerCase()]: scheme === undefined ? token : `${scheme} ${token}` };
  });

  const sendRequest = Effect.fn("HardwareService.send")(function* (
    device: HardwareDeviceConfig,
    action: HardwareActionDefinition,
    query: ReadonlyArray<readonly [string, string]>,
    body: Uint8Array | undefined,
  ) {
    const url = new URL(
      action.path.replace(/^\//, ""),
      device.baseUrl.endsWith("/") ? device.baseUrl : `${device.baseUrl}/`,
    );
    for (const [key, value] of query) url.searchParams.append(key, value);
    const request = HttpClientRequest.make(action.method)(url).pipe(
      HttpClientRequest.setHeaders(yield* credentialHeaders(device)),
      (built) =>
        body === undefined
          ? built
          : HttpClientRequest.bodyUint8Array(built, body, "application/octet-stream"),
    );
    const response = yield* http.execute(request);
    const bytes = new Uint8Array(yield* response.arrayBuffer);
    return {
      status: response.status,
      contentType: response.headers["content-type"] ?? null,
      bytes,
    };
  });
  const send = (
    device: HardwareDeviceConfig,
    action: HardwareActionDefinition,
    query: ReadonlyArray<readonly [string, string]>,
    body?: Uint8Array,
  ) =>
    sendRequest(device, action, query, body).pipe(
      Effect.timeout(body === undefined ? CALL_TIMEOUT : UPLOAD_TIMEOUT),
    );

  const probe = Effect.fn("HardwareService.probe")(function* (device: HardwareDeviceConfig) {
    const current = yield* runtimeFor(device.id);
    const effective = effectiveFor(device, current.definition);
    const health = effective?.health ?? device.acceptedDefinition?.health;
    const now = yield* Clock.currentTimeMillis;
    const result = yield* send(
      device,
      { method: "GET", path: health?.path ?? "/", tier: "read" },
      [],
    ).pipe(
      Effect.timeout(Duration.millis(health?.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS)),
      Effect.result,
    );
    const next: HardwareHealth =
      result._tag === "Success" && result.success.status < 500
        ? {
            status: "online",
            checkedAt: iso(now),
            lastSeenAt: iso(now),
            summary: (() => {
              const fields = health?.summary ?? [];
              if (fields.length === 0) return null;
              const parsed = decodeBody(result.success.bytes, result.success.contentType).body;
              const parts = fields
                .map((field) => readPath(parsed, field))
                .filter(
                  (value) => value !== undefined && value !== null && typeof value !== "object",
                )
                .map(String);
              return parts.length === 0 ? null : parts.join(" · ");
            })(),
          }
        : {
            status: "offline",
            checkedAt: iso(now),
            lastSeenAt: current.health.lastSeenAt,
            summary: current.health.summary,
            error:
              result._tag === "Success"
                ? `HTTP ${result.success.status}`
                : "The device did not answer.",
          };
    const changed =
      next.status !== current.health.status || next.summary !== current.health.summary;
    yield* updateRuntime(device.id, (state) => ({ ...state, health: next, lastProbeAt: now }));
    if (changed) yield* publish;
    return next;
  });

  // Hooks

  const runHooks = Effect.fn("HardwareService.runHooks")(function* (
    device: HardwareDeviceConfig,
    lease: { readonly threadId: ThreadId; readonly purpose: string },
    kind: "acquire" | "renew" | "release",
  ) {
    const effective = effectiveFor(device, (yield* runtimeFor(device.id)).definition);
    const accepted = device.acceptedDefinition;
    const steps: ReadonlyArray<HardwareHookStep> =
      effective?.hooks[kind] ?? accepted?.hooks?.[kind] ?? [];
    const hookActions = effective?.hookActions ?? accepted?.actions ?? {};
    const ttl =
      effective?.deviceTtlSeconds ?? accepted?.deviceTtlSeconds ?? DEFAULT_DEVICE_TTL_SECONDS;
    let failed = false;
    for (const step of steps) {
      const action = hookActions[step.action];
      if (action === undefined) continue;
      const query = Object.entries(step.query ?? {}).map(
        ([key, value]) => [key, fillTemplate(value, lease, ttl)] as const,
      );
      const result = yield* send(device, action, query).pipe(Effect.result);
      const ok = result._tag === "Success" && result.success.status < 400;
      if (!ok) failed = true;
      yield* store.audit({
        deviceId: device.id,
        actor: "system",
        threadId: lease.threadId,
        event: "hook",
        action: step.action,
        detail: {
          hook: kind,
          ...(result._tag === "Success"
            ? { status: result.success.status }
            : { error: "unreachable" }),
        },
      });
    }
    return !failed;
  });

  /** Release hooks retry for a while when the device is unreachable, without holding anything up. */
  const runReleaseHooks = (device: HardwareDeviceConfig, lease: Lease) =>
    runHooks(device, lease, "release").pipe(
      Effect.flatMap((ok) =>
        ok
          ? Effect.void
          : runHooks(device, lease, "release").pipe(
              Effect.flatMap((retried) => (retried ? Effect.void : Effect.fail("retry" as const))),
              Effect.retry(
                Schedule.spaced(RELEASE_RETRY_INTERVAL).pipe(
                  Schedule.upTo({ duration: Duration.millis(RELEASE_RETRY_WINDOW_MS) }),
                ),
              ),
              Effect.catch(() =>
                Effect.logWarning("Hardware release hooks did not complete", {
                  deviceId: device.id,
                }),
              ),
              Effect.forkIn(scope),
              Effect.asVoid,
            ),
      ),
    );

  // Leases

  const endLease = Effect.fn("HardwareService.endLease")(function* (
    deviceId: HardwareDeviceId,
    event: "lease.released" | "lease.revoked" | "lease.expired",
    actor: "thread" | "user" | "system",
    reason: string,
  ) {
    const lease = (yield* Ref.get(leases)).get(deviceId);
    if (lease === undefined) return false;
    yield* Ref.update(leases, (map) => {
      const next = new Map(map);
      next.delete(deviceId);
      return next;
    });
    yield* store.deleteLease(deviceId);
    yield* store.audit({ deviceId, actor, threadId: lease.threadId, event, detail: { reason } });
    const device = yield* findDevice(deviceId);
    if (device !== undefined) yield* runReleaseHooks(device, lease);
    yield* notifyLeaseChanged;
    return true;
  });

  const touch = Effect.fn("HardwareService.touch")(function* (deviceId: HardwareDeviceId) {
    const now = yield* Clock.currentTimeMillis;
    const lease = (yield* Ref.get(leases)).get(deviceId);
    if (lease === undefined) return;
    const persist = now - lease.lastPersistedActivityAt >= ACTIVITY_WRITE_INTERVAL_MS;
    const next: Lease = {
      ...lease,
      lastActivityAt: now,
      lastPersistedActivityAt: persist ? now : lease.lastPersistedActivityAt,
    };
    yield* Ref.update(leases, (map) => new Map(map).set(deviceId, next));
    if (persist) yield* store.saveLease(next);
  });

  const holderTitle = Effect.fn("HardwareService.holderTitle")(function* (
    lease: Lease,
    threadId: ThreadId,
  ) {
    if (lease.threadId === threadId) return "you";
    const shell = yield* getShell(lease.threadId);
    return shell?.title ?? "another thread";
  });

  /** The device and the caller's thread, refused when the thread's project may not use it. */
  const resolve = Effect.fn("HardwareService.resolve")(function* (
    threadId: ThreadId,
    deviceId: HardwareDeviceId,
  ) {
    const device = yield* findDevice(deviceId);
    const shell = yield* getShell(threadId);
    if (device === undefined || shell === null || shell.projectId !== device.projectId) {
      return yield* toolError(
        "not_found",
        `No hardware device "${deviceId}" is registered for this project. Call hardware_list.`,
      );
    }
    return { device, shell };
  });

  const busyError = Effect.fn("HardwareService.busyError")(function* (
    deviceId: HardwareDeviceId,
    lease: Lease,
    threadId: ThreadId,
  ) {
    const holder = yield* holderTitle(lease, threadId);
    const queue = (yield* Ref.get(queues)).get(deviceId) ?? [];
    const shell = yield* getShell(lease.threadId);
    const until =
      lease.keepUntilReleased || threadBusy(shell)
        ? "until it is released"
        : `until about ${iso(lease.lastActivityAt + lease.idleMinutes * 60_000)} if it stays idle`;
    return toolError(
      "busy",
      `"${holder}" holds ${deviceId} for "${lease.purpose}", ${until}. ${queue.length} waiting. Pass wait=true to queue, or ask the user to revoke it.`,
    );
  });

  const grant = Effect.fn("HardwareService.grant")(function* (
    device: HardwareDeviceConfig,
    threadId: ThreadId,
    input: HardwareToolAcquireInput,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const lease: Lease = {
      deviceId: device.id,
      threadId,
      purpose: input.purpose,
      token: NodeCrypto.randomBytes(24).toString("hex"),
      grantedAt: now,
      lastActivityAt: now,
      idleMinutes: input.idleMinutes ?? DEFAULT_IDLE_MINUTES,
      hardExpiresAt: now + HARD_CAP_MS,
      keepUntilReleased: false,
      approvedActions: new Set(),
      lastPersistedActivityAt: now,
      lastRenewHookAt: now,
    };
    yield* Ref.update(leases, (map) => new Map(map).set(device.id, lease));
    yield* store.saveLease(lease);
    yield* store.audit({
      deviceId: device.id,
      actor: "thread",
      threadId,
      event: "lease.granted",
      detail: { purpose: input.purpose },
    });
    yield* runHooks(device, lease, "acquire");
    yield* notifyLeaseChanged;
    return lease;
  });

  const dequeue = (deviceId: HardwareDeviceId, threadId: ThreadId) =>
    Ref.update(queues, (map) =>
      new Map(map).set(
        deviceId,
        (map.get(deviceId) ?? []).filter((waiter) => waiter.threadId !== threadId),
      ),
    ).pipe(Effect.andThen(publish));

  const acquire: HardwareService["Service"]["acquire"] = (threadId, input) =>
    Effect.gen(function* () {
      const { device } = yield* resolve(threadId, input.device);
      yield* loadDefinition(device, { fetch: true });
      const waitUntil =
        (yield* Clock.currentTimeMillis) + (input.waitMinutes ?? DEFAULT_WAIT_MINUTES) * 60_000;
      let queued = false;
      const attempt = Effect.fn("HardwareService.acquireAttempt")(function* () {
        const runtimeState = yield* runtimeFor(device.id);
        if (runtimeState.paused) {
          return yield* toolError("paused", `The user paused ${device.id}. Try again later.`);
        }
        const current = (yield* Ref.get(leases)).get(device.id);
        if (current?.threadId === threadId) {
          const renewed: Lease = {
            ...current,
            purpose: input.purpose,
            idleMinutes: input.idleMinutes ?? current.idleMinutes,
            lastActivityAt: yield* Clock.currentTimeMillis,
            lastPersistedActivityAt: yield* Clock.currentTimeMillis,
          };
          yield* Ref.update(leases, (map) => new Map(map).set(device.id, renewed));
          yield* store.saveLease(renewed);
          yield* publish;
          return Option.some(renewed);
        }
        const queue = (yield* Ref.get(queues)).get(device.id) ?? [];
        const ahead = queue.findIndex((waiter) => waiter.threadId === threadId);
        if (current !== undefined || ahead > 0 || (ahead === -1 && queue.length > 0)) {
          if (!input.wait) {
            return yield* current === undefined
              ? Effect.fail(
                  toolError(
                    "busy",
                    `${queue.length} threads are waiting for ${device.id}. Pass wait=true to queue.`,
                  ),
                )
              : Effect.flatMap(busyError(device.id, current, threadId), Effect.fail);
          }
          return Option.none<Lease>();
        }
        const health = yield* probe(device);
        if (health.status !== "online") {
          if (!input.wait) {
            return yield* toolError(
              "offline",
              `${device.id} did not answer at ${device.baseUrl}. Pass wait=true to wait for it.`,
            );
          }
          return Option.none<Lease>();
        }
        return Option.some(yield* grant(device, threadId, input));
      });
      while (true) {
        const signal = yield* Ref.get(leaseChanged);
        const outcome = yield* lockFor(device.id).withPermits(1)(attempt());
        if (Option.isSome(outcome)) {
          if (queued) yield* dequeue(device.id, threadId);
          return {
            device: device.id,
            hardExpiresAt:
              outcome.value.hardExpiresAt === null ? null : iso(outcome.value.hardExpiresAt),
            proxyBaseUrl: proxyBaseUrl(outcome.value.token),
          } satisfies HardwareToolAcquireResult;
        }
        if (!queued) {
          queued = true;
          const queuedAt = yield* Clock.currentTimeMillis;
          yield* Ref.update(queues, (map) =>
            new Map(map).set(device.id, [...(map.get(device.id) ?? []), { threadId, queuedAt }]),
          );
          yield* store.audit({
            deviceId: device.id,
            actor: "thread",
            threadId,
            event: "lease.queued",
            detail: { purpose: input.purpose },
          });
          yield* publish;
        }
        const remaining = waitUntil - (yield* Clock.currentTimeMillis);
        if (remaining <= 0) {
          const current = (yield* Ref.get(leases)).get(device.id);
          return yield* current === undefined
            ? Effect.fail(toolError("offline", `${device.id} did not come online in time.`))
            : Effect.flatMap(busyError(device.id, current, threadId), Effect.fail);
        }
        // Re-check on any lease change, and every tick for health changes.
        yield* Deferred.await(signal).pipe(
          Effect.timeout(Duration.millis(Math.min(remaining, Duration.toMillis(TICK_INTERVAL)))),
          Effect.ignore,
        );
      }
    }).pipe(
      Effect.onExit(() =>
        Ref.get(queues).pipe(
          Effect.flatMap((map) =>
            (map.get(input.device) ?? []).some((waiter) => waiter.threadId === threadId)
              ? dequeue(input.device, threadId)
              : Effect.void,
          ),
        ),
      ),
    );

  // Approvals

  /**
   * Opens an approval card in the caller's thread and waits for the answer.
   * The card closes as cancelled if the call ends any other way.
   */
  const requestApproval = Effect.fn("HardwareService.requestApproval")(function* (input: {
    readonly threadId: ThreadId;
    readonly device: HardwareDeviceConfig;
    readonly actionName: string;
    readonly prompt: string;
    readonly toolInput: unknown;
  }) {
    const records = yield* threads
      .getThreadRecords(input.threadId, ["runs"])
      .pipe(Effect.mapError(() => toolError("unavailable", "Could not read this thread.")));
    const run = ThreadManagementService.latestActiveRun(records);
    if (run === undefined || run.rootNodeId === null) {
      return yield* toolError(
        "forbidden",
        "This action needs the user's approval, which can only be asked during a running turn.",
      );
    }
    const requestId = RuntimeRequestId.make(`runtime-request:hardware:${NodeCrypto.randomUUID()}`);
    const record = (approvalStatus: "pending" | "cancelled") =>
      threads.dispatch({
        type: "server_approval.record",
        commandId: CommandId.make(`hardware-approval:${requestId}:${approvalStatus}`),
        threadId: input.threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        requestId,
        approvalStatus,
        toolName: "hardware_call",
        toolInput: input.toolInput,
        prompt: input.prompt,
        options: [
          { decision: "accept", label: "Allow once" },
          { decision: "acceptForSession", label: "Allow for this lease" },
          { decision: "decline", label: "Decline" },
        ],
      });
    yield* record("pending").pipe(
      Effect.mapError(() => toolError("unavailable", "Could not ask the user for approval.")),
    );
    yield* store.audit({
      deviceId: input.device.id,
      actor: "thread",
      threadId: input.threadId,
      event: "approval.requested",
      action: input.actionName,
      detail: { prompt: input.prompt },
    });
    const decision = yield* Effect.gen(function* () {
      while (true) {
        const projection = yield* threads
          .getThreadRecords(input.threadId, ["runtimeRequests", "runs"])
          .pipe(Effect.orElseSucceed(() => null));
        const request = projection?.runtimeRequests.find((candidate) => candidate.id === requestId);
        if (request !== undefined && request.status !== "pending") {
          return request.status === "resolved" ? (request.decision ?? "decline") : "cancel";
        }
        const live = projection?.runs.find((candidate) => candidate.id === run.id);
        if (live !== undefined && !ThreadManagementService.isActiveRun(live)) return "cancel";
        yield* Effect.sleep(APPROVAL_POLL_INTERVAL);
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: APPROVAL_TIMEOUT,
        orElse: () => Effect.succeed<ProviderApprovalDecision | "timeout">("timeout"),
      }),
      Effect.onExit(() => record("cancelled").pipe(Effect.ignore)),
    );
    yield* store.audit({
      deviceId: input.device.id,
      actor: "user",
      threadId: input.threadId,
      event: "approval.decided",
      action: input.actionName,
      detail: { decision },
    });
    return decision;
  });

  // Calls

  const readBodyFile = Effect.fn("HardwareService.readBodyFile")(function* (
    shell: OrchestrationV2ThreadShell,
    device: HardwareDeviceConfig,
    bodyFile: string,
  ) {
    const root = shell.worktreePath ?? Option.getOrUndefined(yield* projectRoot(device));
    if (root === undefined)
      return yield* toolError("invalid_request", "This thread has no workspace.");
    const realRoot = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root));
    const target = yield* fs
      .realPath(path.resolve(realRoot, bodyFile))
      .pipe(Effect.mapError(() => toolError("invalid_request", `${bodyFile} does not exist.`)));
    const relative = path.relative(realRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* toolError(
        "invalid_request",
        "bodyFile must be inside this thread's workspace.",
      );
    }
    const bytes = yield* fs
      .readFile(target)
      .pipe(Effect.mapError(() => toolError("invalid_request", `Could not read ${bodyFile}.`)));
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      return yield* toolError("invalid_request", `${bodyFile} is larger than 4 MB.`);
    }
    const head = yield* git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const commit = yield* git(root, ["rev-parse", "--short", "HEAD"]);
    const dirty = yield* git(root, ["status", "--porcelain", "--", relative]);
    return {
      bytes,
      relative,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      revision:
        Option.isSome(head) && Option.isSome(commit) && head.value.exitCode === 0
          ? `${head.value.stdout.trim()}@${commit.value.stdout.trim()}${
              Option.isSome(dirty) && dirty.value.stdout.trim().length > 0
                ? " (uncommitted changes)"
                : ""
            }`
          : null,
    };
  });

  const describeCall = (
    device: HardwareDeviceConfig,
    name: string,
    action: HardwareActionDefinition,
    query: ReadonlyArray<readonly [string, string]>,
    file:
      | {
          readonly relative: string;
          readonly bytes: Uint8Array;
          readonly sha256: string;
          readonly revision: string | null;
        }
      | undefined,
  ) => {
    const target = `${action.method} ${action.path}${
      query.length === 0
        ? ""
        : `?${new URLSearchParams(query.map(([key, value]): [string, string] => [key, value])).toString()}`
    }`;
    const fileText =
      file === undefined
        ? ""
        : ` with ${file.relative} (${(file.bytes.byteLength / 1024).toFixed(1)} KB, sha ${file.sha256.slice(0, 10)}${
            file.revision === null ? "" : `, ${file.revision}`
          })`;
    return `Run "${name}" on ${device.id}: ${target}${fileText}`;
  };

  type CallVia = "tool" | "proxy";

  const performCall = Effect.fn("HardwareService.performCall")(function* (
    threadId: ThreadId,
    input: HardwareToolCallInput,
    via: CallVia,
  ) {
    const { device, shell } = yield* resolve(threadId, input.device);
    const runtimeState = yield* runtimeFor(device.id);
    if (runtimeState.paused) {
      return yield* toolError("paused", `The user paused ${device.id}.`);
    }
    const effective = effectiveFor(device, yield* loadDefinition(device));
    if (effective === null) {
      return yield* toolError(
        "unavailable",
        `${device.id} has no usable definition on the default branch. The user can check Settings → Hardware.`,
      );
    }
    const actions = yield* actionsForThread(device, shell, effective);
    const action = actions[input.action];
    if (action === undefined) {
      return yield* toolError(
        "invalid_request",
        `${device.id} has no action "${input.action}". Actions: ${Object.keys(actions).toSorted().join(", ")}.`,
      );
    }
    const query = Object.entries(input.query ?? {}).map(
      ([key, value]) => [key, String(value)] as const,
    );
    const refused = refusedQueryKeys(
      action,
      query.map(([key]) => key),
    );
    if (refused.length > 0) {
      return yield* toolError(
        "invalid_request",
        `"${input.action}" does not take ${refused.join(", ")}. It takes: ${(action.query ?? []).join(", ") || "nothing"}.`,
      );
    }
    if (action.body === "file" && input.bodyFile === undefined) {
      return yield* toolError("invalid_request", `"${input.action}" sends a file; pass bodyFile.`);
    }
    if (action.tier !== "read") {
      const lease = (yield* Ref.get(leases)).get(device.id);
      if (lease === undefined) {
        return yield* toolError(
          "not_held",
          `"${input.action}" needs a lease. Call hardware_acquire for ${device.id} first.`,
        );
      }
      if (lease.threadId !== threadId)
        return yield* Effect.flatMap(busyError(device.id, lease, threadId), Effect.fail);
    }
    const file =
      action.body === "file" && input.bodyFile !== undefined
        ? yield* readBodyFile(shell, device, input.bodyFile)
        : undefined;
    if (action.tier === "approve") {
      if (via === "proxy") {
        return yield* toolError(
          "forbidden",
          `"${input.action}" needs the user's approval; call it with hardware_call, not the proxy.`,
        );
      }
      const lease = (yield* Ref.get(leases)).get(device.id);
      if (lease === undefined || !lease.approvedActions.has(input.action)) {
        const decision = yield* requestApproval({
          threadId,
          device,
          actionName: input.action,
          prompt: describeCall(device, input.action, action, query, file),
          toolInput: {
            device: device.id,
            action: input.action,
            query: input.query ?? {},
            ...(input.bodyFile === undefined ? {} : { bodyFile: input.bodyFile }),
          },
        });
        if (decision === "timeout") {
          return yield* toolError(
            "approval_timeout",
            "Nobody answered the approval in 10 minutes.",
          );
        }
        if (
          decision !== "accept" &&
          decision !== "acceptForSession" &&
          decision !== "acceptAlways"
        ) {
          return yield* toolError("approval_declined", `The user declined "${input.action}".`);
        }
        if (decision !== "accept") {
          // The lease may have ended while the card waited; then there is nothing to remember.
          yield* Ref.update(leases, (map) => {
            const current = map.get(device.id);
            return current === undefined || current.threadId !== threadId
              ? map
              : new Map(map).set(device.id, {
                  ...current,
                  approvedActions: new Set([...current.approvedActions, input.action]),
                });
          });
        }
        const still = (yield* Ref.get(leases)).get(device.id);
        if (still?.threadId !== threadId) {
          return yield* toolError(
            "not_held",
            `The lease on ${device.id} ended while waiting for approval.`,
          );
        }
      }
    }
    const started = yield* Clock.currentTimeMillis;
    const result = yield* send(device, action, query, file?.bytes).pipe(
      Effect.mapError(() =>
        toolError("request_failed", `${device.id} did not answer ${action.method} ${action.path}.`),
      ),
    );
    if (action.tier !== "read") yield* touch(device.id);
    yield* store.audit({
      deviceId: device.id,
      actor: "thread",
      threadId,
      event: "call",
      action: input.action,
      detail: {
        via,
        status: result.status,
        durationMs: (yield* Clock.currentTimeMillis) - started,
        ...(query.length === 0 ? {} : { query: Object.fromEntries(query) }),
        ...(file === undefined
          ? {}
          : { file: file.relative, bytes: file.bytes.byteLength, sha256: file.sha256 }),
      },
    });
    return result;
  });

  const call: HardwareService["Service"]["call"] = (threadId, input) =>
    performCall(threadId, input, "tool").pipe(
      Effect.map((result) => {
        const decoded = decodeBody(result.bytes, result.contentType);
        return {
          status: result.status,
          contentType: result.contentType,
          body: decoded.body,
          truncated: decoded.truncated,
        };
      }),
    );

  const proxy: HardwareService["Service"]["proxy"] = (request) =>
    Effect.gen(function* () {
      const lease = [...(yield* Ref.get(leases)).values()].find(
        (candidate) => candidate.token === request.token,
      );
      if (lease === undefined) {
        return {
          status: 410,
          contentType: "application/json",
          body: encodeJson({ error: "lease_ended", hint: "Call hardware_acquire again." }),
        };
      }
      const device = yield* findDevice(lease.deviceId);
      const definition = device === undefined ? null : yield* loadDefinition(device);
      const effective = device === undefined ? null : effectiveFor(device, definition);
      const shell = yield* getShell(lease.threadId);
      const actions =
        device === undefined || effective === null || shell === null
          ? {}
          : yield* actionsForThread(device, shell, effective);
      const match = actionForRequest(actions, request.method, request.path);
      if (match === undefined) {
        return {
          status: 404,
          contentType: "application/json",
          body: encodeJson({
            error: "unknown_action",
            hint: "Only actions listed by hardware_list are forwarded.",
          }),
        };
      }
      const query: Record<string, string> = {};
      for (const [key, value] of request.query) query[key] = value;
      const result = yield* performCall(
        lease.threadId,
        { device: lease.deviceId, action: match.name, query },
        "proxy",
      ).pipe(Effect.result);
      if (result._tag === "Failure") {
        const status =
          result.failure.code === "forbidden" || result.failure.code === "paused"
            ? 403
            : result.failure.code === "invalid_request"
              ? 400
              : result.failure.code === "request_failed"
                ? 502
                : 409;
        return {
          status,
          contentType: "application/json",
          body: encodeJson({ error: result.failure.code, message: result.failure.reason }),
        };
      }
      return {
        status: result.success.status,
        contentType: result.success.contentType,
        body: result.success.bytes,
      };
    });

  const release: HardwareService["Service"]["release"] = (threadId, deviceId) =>
    Effect.gen(function* () {
      yield* resolve(threadId, deviceId);
      return yield* lockFor(deviceId).withPermits(1)(
        Effect.gen(function* () {
          const lease = (yield* Ref.get(leases)).get(deviceId);
          if (lease?.threadId !== threadId) return { released: false };
          yield* endLease(deviceId, "lease.released", "thread", "Released by the agent.");
          return { released: true };
        }),
      );
    });

  const listForThread: HardwareService["Service"]["listForThread"] = (threadId, only) =>
    Effect.gen(function* () {
      const shell = yield* getShell(threadId);
      if (shell === null) return [];
      const usable = (yield* devices).filter(
        (device) =>
          device.projectId === shell.projectId && (only === undefined || device.id === only),
      );
      return yield* Effect.forEach(usable, (device) =>
        Effect.gen(function* () {
          const definition = yield* loadDefinition(device);
          const runtimeState = yield* runtimeFor(device.id);
          const health =
            runtimeState.lastProbeAt === 0 ? yield* probe(device) : runtimeState.health;
          const effective = effectiveFor(device, definition);
          const lease = (yield* Ref.get(leases)).get(device.id);
          const leaseShell = lease === undefined ? null : yield* getShell(lease.threadId);
          return {
            id: device.id,
            name: definition.main?.name ?? device.id,
            health: health.status,
            summary: health.summary,
            holder: lease === undefined ? null : yield* holderTitle(lease, threadId),
            leaseIdleExpiresAt:
              lease === undefined || lease.keepUntilReleased || threadBusy(leaseShell)
                ? null
                : iso(lease.lastActivityAt + lease.idleMinutes * 60_000),
            queueLength: ((yield* Ref.get(queues)).get(device.id) ?? []).length,
            paused: runtimeState.paused,
            actions:
              effective === null
                ? []
                : summarizeActions(yield* actionsForThread(device, shell, effective)),
            definitionPending: (effective?.pendingChanges.length ?? 0) > 0,
          } satisfies HardwareToolDevice;
        }),
      );
    });

  // User controls

  const requireDevice = (deviceId: HardwareDeviceId) =>
    Effect.flatMap(findDevice(deviceId), (device) =>
      device === undefined
        ? Effect.fail(new HardwareError({ reason: `No hardware device "${deviceId}".` }))
        : Effect.succeed(device),
    );

  const revoke = ({ deviceId }: { readonly deviceId: HardwareDeviceId }) =>
    requireDevice(deviceId).pipe(
      Effect.andThen(
        lockFor(deviceId).withPermits(1)(
          endLease(deviceId, "lease.revoked", "user", "Revoked by the user."),
        ),
      ),
      Effect.asVoid,
    );

  const setPaused = ({
    deviceId,
    paused,
  }: {
    readonly deviceId: HardwareDeviceId;
    readonly paused: boolean;
  }) =>
    Effect.gen(function* () {
      yield* requireDevice(deviceId);
      yield* updateRuntime(deviceId, (current) => ({ ...current, paused }));
      yield* store.audit({
        deviceId,
        actor: "user",
        threadId: null,
        event: paused ? "paused" : "resumed",
      });
      yield* notifyLeaseChanged;
    });

  const setKeep = ({
    deviceId,
    keepUntilReleased,
  }: {
    readonly deviceId: HardwareDeviceId;
    readonly keepUntilReleased: boolean;
  }) =>
    Effect.gen(function* () {
      const lease = (yield* Ref.get(leases)).get(deviceId);
      if (lease === undefined) {
        return yield* new HardwareError({ reason: `Nobody holds ${deviceId}.` });
      }
      const now = yield* Clock.currentTimeMillis;
      const next: Lease = {
        ...lease,
        keepUntilReleased,
        lastActivityAt: now,
        // Turning keep off restarts the cap rather than ending the lease at once.
        hardExpiresAt: keepUntilReleased ? null : now + HARD_CAP_MS,
      };
      yield* Ref.update(leases, (map) => new Map(map).set(deviceId, next));
      yield* store.saveLease(next);
      yield* publish;
    });

  const acceptDefinition = ({ deviceId }: { readonly deviceId: HardwareDeviceId }) =>
    Effect.gen(function* () {
      const device = yield* requireDevice(deviceId);
      const loaded = yield* loadDefinition(device, { fetch: true, force: true });
      if (loaded.main === null) {
        return yield* new HardwareError({
          reason: loaded.error ?? "There is no definition to accept.",
        });
      }
      const main = loaded.main;
      // updateSettings replaces the whole list, so read it right before writing.
      // (withSettingsSnapshot would deadlock: it pauses the writes it waits on.)
      yield* settingsService.getSettings.pipe(
        Effect.flatMap((settings) =>
          settingsService.updateSettings({
            hardwareDevices: settings.hardwareDevices.map((entry) =>
              entry.id === deviceId ? { ...entry, acceptedDefinition: main } : entry,
            ),
          }),
        ),
        Effect.mapError(() => new HardwareError({ reason: "Could not save the settings." })),
      );
      yield* store.audit({
        deviceId,
        actor: "user",
        threadId: null,
        event: "definition.accepted",
        detail: { source: loaded.source },
      });
      yield* publish;
    });

  const setCredential = ({
    deviceId,
    value,
  }: {
    readonly deviceId: HardwareDeviceId;
    readonly value: string | null;
  }) =>
    Effect.gen(function* () {
      yield* requireDevice(deviceId);
      yield* (
        value === null
          ? secrets.remove(secretName(deviceId))
          : secrets.set(secretName(deviceId), new TextEncoder().encode(value))
      ).pipe(
        Effect.mapError(() => new HardwareError({ reason: "Could not store the credential." })),
      );
      yield* Ref.update(credentialPresent, (map) => new Map(map).set(deviceId, value !== null));
      yield* publish;
    });

  const control: HardwareService["Service"]["control"] = (input) => {
    switch (input.type) {
      case "revoke":
        return revoke(input);
      case "set-paused":
        return setPaused(input);
      case "set-keep":
        return setKeep(input);
    }
  };

  const configure: HardwareService["Service"]["configure"] = (input) =>
    input.type === "accept-definition" ? acceptDefinition(input) : setCredential(input);

  const auditList: HardwareService["Service"]["auditList"] = ({ deviceId, limit }) =>
    Effect.map(store.listAudit(deviceId, limit ?? 100), (entries) => ({ entries }));

  // Background: expiry, renew hooks, health, definition reloads.

  const tick = Effect.gen(function* () {
    const configured = yield* devices;
    const observed = (yield* Ref.get(subscribers)) > 0;
    const now = yield* Clock.currentTimeMillis;
    for (const device of configured) {
      yield* lockFor(device.id).withPermits(1)(
        Effect.gen(function* () {
          const lease = (yield* Ref.get(leases)).get(device.id);
          if (lease === undefined) return;
          const shell = yield* getShell(lease.threadId);
          if (threadGone(shell)) {
            yield* endLease(
              device.id,
              "lease.expired",
              "system",
              "The thread was deleted or archived.",
            );
            return;
          }
          if (threadBusy(shell)) yield* touch(device.id);
          const current = (yield* Ref.get(leases)).get(device.id) ?? lease;
          if (!current.keepUntilReleased) {
            if (current.hardExpiresAt !== null && now >= current.hardExpiresAt) {
              yield* endLease(
                device.id,
                "lease.expired",
                "system",
                "The lease reached its time limit.",
              );
              return;
            }
            if (
              !threadBusy(shell) &&
              now >= current.lastActivityAt + current.idleMinutes * 60_000
            ) {
              yield* endLease(device.id, "lease.expired", "system", "The thread was idle.");
              return;
            }
          }
          const effective = effectiveFor(device, (yield* runtimeFor(device.id)).definition);
          const renewEvery =
            Math.min(
              ...(effective?.hooks.renew ?? []).map((step) => (step.everySeconds ?? 60) * 1000),
            ) || DEFAULT_RENEW_EVERY_MS;
          if (
            (effective?.hooks.renew?.length ?? 0) > 0 &&
            now - current.lastRenewHookAt >= renewEvery
          ) {
            yield* Ref.update(leases, (map) =>
              map.has(device.id)
                ? new Map(map).set(device.id, { ...current, lastRenewHookAt: now })
                : map,
            );
            yield* runHooks(device, current, "renew");
          }
        }),
      );
      const leased = (yield* Ref.get(leases)).has(device.id);
      if (observed || leased) {
        const runtimeState = yield* runtimeFor(device.id);
        const effective = effectiveFor(device, runtimeState.definition);
        const interval =
          (effective?.health?.intervalSeconds ?? 0) * 1000 || DEFAULT_HEALTH_INTERVAL_MS;
        if (now - runtimeState.lastProbeAt >= interval) yield* probe(device);
        if (
          runtimeState.definition === null ||
          now - runtimeState.definition.loadedAt >= DEFINITION_RELOAD_MS
        ) {
          yield* loadDefinition(device);
          yield* publish;
        }
      }
    }
    // Leases on devices that were removed from settings end too.
    const known = new Set(configured.map((device) => device.id));
    for (const deviceId of (yield* Ref.get(leases)).keys()) {
      if (!known.has(deviceId)) {
        yield* endLease(deviceId, "lease.expired", "system", "The device was removed.");
      }
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Hardware tick failed", { cause })));

  // Restore leases. Those that ran out while the server was down end now,
  // which runs their release hooks once the device answers.
  const stored = yield* store.loadLeases;
  yield* Ref.set(
    leases,
    new Map(
      stored.map((lease) => [
        lease.deviceId,
        {
          ...lease,
          approvedActions: new Set<string>(),
          lastPersistedActivityAt: lease.lastActivityAt,
          lastRenewHookAt: 0,
        },
      ]),
    ),
  );
  for (const device of yield* devices) {
    const present = yield* secrets.get(secretName(device.id)).pipe(
      Effect.map(Option.isSome),
      Effect.orElseSucceed(() => false),
    );
    yield* Ref.update(credentialPresent, (map) => new Map(map).set(device.id, present));
  }

  yield* forkParked(
    Effect.gen(function* () {
      yield* store.pruneAudit;
      yield* tick.pipe(Effect.repeat(Schedule.spaced(TICK_INTERVAL)));
    }),
  );
  yield* forkParked(
    settingsService.streamChanges.pipe(
      Stream.map((settings) => encodeJson(settings.hardwareDevices)),
      Stream.changes,
      Stream.runForEach(() =>
        Effect.gen(function* () {
          for (const device of yield* devices) yield* loadDefinition(device, { force: true });
          yield* publish;
        }),
      ),
    ),
  );

  const stateStream: HardwareService["Service"]["stateStream"] = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(updates);
      yield* Effect.acquireRelease(
        Ref.update(subscribers, (count) => count + 1),
        () => Ref.update(subscribers, (count) => count - 1),
      );
      // A new viewer should not wait a whole tick for fresh health.
      yield* tick.pipe(Effect.forkIn(scope));
      const initial = yield* state;
      return Stream.concat(Stream.make(initial), Stream.fromSubscription(subscription));
    }),
  ).pipe(Stream.scoped);

  return HardwareService.of({
    state,
    stateStream,
    listForThread,
    acquire,
    call,
    release,
    proxy,
    control,
    configure,
    auditList,
  });
});

export const layer = Layer.effect(HardwareService, make).pipe(Layer.provide(HardwareStore.layer));

export const HARDWARE_PROXY_PATH_PREFIX = PROXY_PATH_PREFIX;
