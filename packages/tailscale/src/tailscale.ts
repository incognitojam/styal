// @effect-diagnostics nodeBuiltinImport:off -- Serve recovery needs a native TCP probe and a cross-process SQLite lock.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isLocalLoopbackHost, normalizeHostname } from "@t3tools/shared/hostClassification";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;
/**
 * Bounds `tailscale status` and `tailscale debug prefs`. Allows the 1.8-2.6 s
 * `tailscale status` has been measured at when styal spawns it on Windows.
 * A CLI that never answers takes longer than this to fail, because the kill
 * that follows the timeout also takes time (`taskkill` on Windows).
 */
const TAILSCALE_STATUS_TIMEOUT = Duration.millis(3_500);
/**
 * How long a probe killed on timeout gets to exit after SIGTERM before its
 * process group is SIGKILLed. Without it the spawner never escalates, so a group
 * member that ignores SIGTERM outlives the call. Short because the timeout error
 * only surfaces once cleanup finishes, and a healthy `tailscale` exits at once.
 */
const TAILSCALE_KILL_GRACE = Duration.millis(500);
const TAILSCALE_SERVE_TIMEOUT = Duration.seconds(10);
const TAILSCALE_PROBE_TIMEOUT = Duration.millis(2_500);

const tailscaleCommandForPlatform = (platform: NodeJS.Platform): "tailscale" | "tailscale.exe" =>
  platform === "win32" ? "tailscale.exe" : "tailscale";

const TailscaleCommandContext = {
  executable: Schema.Literals(["tailscale", "tailscale.exe"]),
  subcommand: Schema.Literals(["status", "serve", "debug"]),
  argumentCount: Schema.Number,
};

/**
 * Failure kinds we can name without quoting the CLI. Anything unrecognized
 * becomes "unknown" rather than falling back to raw text — stderr can contain
 * auth keys (`tskey-…`) and node names, and these labels are logged.
 */
export const TailscaleStderrDiagnostic = Schema.Literals([
  "no-existing-handler",
  "not-logged-in",
  "not-running",
  "permission-denied",
  "unknown",
]);
export type TailscaleStderrDiagnostic = typeof TailscaleStderrDiagnostic.Type;

const STDERR_DIAGNOSTIC_PATTERNS: ReadonlyArray<
  readonly [RegExp, Exclude<TailscaleStderrDiagnostic, "unknown">]
> = [
  [/handler does not exist/i, "no-existing-handler"],
  [/not logged in|logged out|needs? login/i, "not-logged-in"],
  // Only answers that confirm no daemon; a dial can also fail for want of permission. Windows
  // reports a missing service as its pipe not being found, without the usual prefix.
  [
    /doesn't appear to be running|tailscaled\.service not running|tailscale is stopped|tailscaled: the system cannot find the file specified|failed to connect to local tailscale[\s\S]*(connection refused|no such file or directory|cannot find the file)/i,
    "not-running",
  ],
  [/permission denied|access denied|must be root|operation not permitted/i, "permission-denied"],
];

const stderrDiagnosticOf = (stderr: string): TailscaleStderrDiagnostic | undefined => {
  if (stderr.trim().length === 0) {
    return undefined;
  }
  return STDERR_DIAGNOSTIC_PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? "unknown";
};

export class TailscaleCommandSpawnError extends Schema.TaggedError<TailscaleCommandSpawnError>()(
  "TailscaleCommandSpawnError",
  {
    ...TailscaleCommandContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn tailscale ${this.subcommand}.`;
  }
}

class TailscaleCommandOutputError extends Schema.TaggedError<TailscaleCommandOutputError>()(
  "TailscaleCommandOutputError",
  {
    ...TailscaleCommandContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read output from tailscale ${this.subcommand}.`;
  }
}

export class TailscaleCommandExitError extends Schema.TaggedError<TailscaleCommandExitError>()(
  "TailscaleCommandExitError",
  {
    ...TailscaleCommandContext,
    exitCode: Schema.Number,
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.Number,
    stderrDiagnostic: Schema.optional(TailscaleStderrDiagnostic),
  },
) {
  override get message(): string {
    return `tailscale ${this.subcommand} exited with code ${this.exitCode}.`;
  }
}

export class TailscaleCommandTimeoutError extends Schema.TaggedError<TailscaleCommandTimeoutError>()(
  "TailscaleCommandTimeoutError",
  {
    ...TailscaleCommandContext,
    timeoutMs: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `tailscale ${this.subcommand} timed out after ${this.timeoutMs}ms.`;
  }
}

export type TailscaleCommandError =
  | TailscaleCommandSpawnError
  | TailscaleCommandOutputError
  | TailscaleCommandExitError
  | TailscaleCommandTimeoutError;

export class TailscaleStatusParseError extends Schema.TaggedError<TailscaleStatusParseError>()(
  "TailscaleStatusParseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to decode tailscale status JSON.";
  }
}

export class TailscaleServePortOccupiedError extends Schema.TaggedError<TailscaleServePortOccupiedError>()(
  "TailscaleServePortOccupiedError",
  { servePort: Schema.Number, unrecorded: Schema.optional(Schema.Boolean) },
) {
  override get message(): string {
    return this.unrecorded
      ? `Tailscale Serve port ${this.servePort} is not recorded as server-managed (including mappings from older releases or pairing). Choose --tailscale-serve-port, or remove the stale mapping manually with tailscale serve --https=${this.servePort} --set-path=/ off before restarting.`
      : `Tailscale Serve port ${this.servePort} has a protected or unrecognized mapping. Choose --tailscale-serve-port, or inspect and remove the stale mapping manually before restarting.`;
  }
}

export class TailscaleServeRecoveryBusyError extends Schema.TaggedError<TailscaleServeRecoveryBusyError>()(
  "TailscaleServeRecoveryBusyError",
  { servePort: Schema.Number },
) {
  override get message(): string {
    return `Another styal process is updating Tailscale Serve port ${this.servePort}; retry after that operation finishes.`;
  }
}

export class TailscaleServeRecordError extends Schema.TaggedError<TailscaleServeRecordError>()(
  "TailscaleServeRecordError",
  {
    stage: Schema.Literals(["directory", "open", "lock", "record"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const action = {
      directory: "create the per-account Serve state directory",
      open: "open the per-account Serve ownership record",
      lock: "lock the per-account Serve ownership record",
      record: "read or save the per-account Serve ownership record",
    }[this.stage];
    return `Could not ${action}; check this account's state-directory permissions and available disk space. Automatic recovery requires a usable ownership record.`;
  }
}

export class TailscaleServeNotConfiguredError extends Schema.TaggedError<TailscaleServeNotConfiguredError>()(
  "TailscaleServeNotConfiguredError",
  { servePort: Schema.Number },
) {
  override get message(): string {
    return `tailscale serve reported success but port ${this.servePort} does not have the requested mapping. Inspect Serve status and the tailnet's HTTPS settings before retrying; no ownership was recorded.`;
  }
}

export type TailscaleServeError =
  | TailscaleCommandError
  | TailscaleStatusParseError
  | TailscaleServePortOccupiedError
  | TailscaleServeRecoveryBusyError
  | TailscaleServeRecordError
  | TailscaleServeNotConfiguredError;

const TailscaleStatusSelf = Schema.Struct({
  DNSName: Schema.optional(Schema.Unknown),
  TailscaleIPs: Schema.optional(Schema.Unknown),
  CapMap: Schema.optional(Schema.Unknown),
});

const TailscaleStatusJson = Schema.Struct({
  Self: Schema.optional(TailscaleStatusSelf),
});

const TailscaleServeConfigJson = Schema.Struct({
  TCP: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        HTTPS: Schema.optional(Schema.Unknown),
        TCPForward: Schema.optional(Schema.String),
      }),
    ),
  ),
  Web: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        Handlers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ),
  ),
  AllowFunnel: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});

const TailscaleServeStatusJson = Schema.Struct({
  ...TailscaleServeConfigJson.fields,
  // A Tailscale Service's routes, and those of each `tailscale serve` still running in the foreground.
  Services: Schema.optional(Schema.Record(Schema.String, TailscaleServeConfigJson)),
  Foreground: Schema.optional(Schema.Record(Schema.String, TailscaleServeConfigJson)),
});

type TailscaleServeStatusJson = typeof TailscaleServeStatusJson.Type;

export type TailscaleStatusJson = typeof TailscaleStatusJson.Type;

export interface TailscaleStatus {
  readonly magicDnsName: string | null;
  readonly tailnetIpv4Addresses: readonly string[];
  /**
   * `tailscale serve --https` needs the `https` capability, which the control
   * plane grants once the tailnet enables HTTPS certificates. `null` when the
   * CLI reports no capability map (older CLI), so callers still attempt serve.
   */
  readonly httpsServeEnabled: boolean | null;
}

const collectStdout = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const collectStderr = collectStdout;

const decodeTailscaleStatusJson = Schema.decodeEffect(Schema.fromJsonString(TailscaleStatusJson));
const TailscaleServeRawConfig = Schema.Struct({
  TCP: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  Web: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  AllowFunnel: TailscaleServeConfigJson.fields.AllowFunnel,
});
const decodeTailscaleServeStatusJson = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.NullOr(
      Schema.Struct({
        ...TailscaleServeRawConfig.fields,
        Services: Schema.optional(Schema.Unknown),
        Foreground: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ),
  ),
  { onExcessProperty: "error" },
);
const decodeServeRawConfig = Schema.decodeUnknownEffect(TailscaleServeRawConfig, {
  onExcessProperty: "error",
});
const decodeServeConfig = Schema.decodeUnknownEffect(TailscaleServeConfigJson, {
  onExcessProperty: "error",
});

const selectedServeConfig = Effect.fn("tailscale.selectedServeConfig")(function* (
  raw: unknown,
  servePort: number,
) {
  const config = yield* decodeServeRawConfig(raw);
  return yield* decodeServeConfig({
    TCP:
      config.TCP === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(config.TCP).filter(([port]) => Number(port) === servePort),
          ),
    Web:
      config.Web === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(config.Web).filter(
              ([authority]) => authorityPort(authority) === servePort,
            ),
          ),
    AllowFunnel:
      config.AllowFunnel === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(config.AllowFunnel).filter(
              ([authority]) => authorityPort(authority) === servePort,
            ),
          ),
  });
});

function normalizeMagicDnsName(status: TailscaleStatusJson): string | null {
  const dnsName = status.Self?.DNSName;
  if (typeof dnsName !== "string") {
    return null;
  }

  const normalized = dnsName.trim().replace(/\.$/u, "");
  return normalized.length > 0 ? normalized : null;
}

export function isTailscaleIpv4Address(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const [first, second, third, fourth] = parts.map((part) => Number.parseInt(part, 10));
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    [first, second, third, fourth].some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return first === 100 && second >= 64 && second <= 127;
}

export const parseTailscaleStatus = (
  rawStatusJson: string,
): Effect.Effect<TailscaleStatus, TailscaleStatusParseError> =>
  decodeTailscaleStatusJson(rawStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map((parsed) => {
      const rawIps = parsed.Self?.TailscaleIPs;
      const tailnetIpv4Addresses: Array<string> = [];
      if (Array.isArray(rawIps)) {
        for (const address of rawIps) {
          if (typeof address === "string" && isTailscaleIpv4Address(address)) {
            tailnetIpv4Addresses.push(address);
          }
        }
      }

      const capMap = parsed.Self?.CapMap;
      return {
        magicDnsName: normalizeMagicDnsName(parsed),
        tailnetIpv4Addresses,
        httpsServeEnabled:
          typeof capMap === "object" && capMap !== null && !Array.isArray(capMap)
            ? Object.hasOwn(capMap, "https")
            : null,
      };
    }),
  );

const readTailscaleOutput = Effect.fn("tailscale.readTailscaleOutput")(function* (
  subcommand: "status" | "serve" | "debug",
  args: readonly string[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostPlatform = yield* HostProcess.Platform;
  const executable = tailscaleCommandForPlatform(hostPlatform);
  const commandContext = {
    executable,
    subcommand,
    argumentCount: args.length,
  };
  const command = ChildProcess.make(executable, [...args], {
    forceKillAfter: TAILSCALE_KILL_GRACE,
  });
  return yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(command).pipe(
      Effect.mapError((cause) => new TailscaleCommandSpawnError({ ...commandContext, cause })),
      // Spawning can also fail as a defect rather than a typed error - a
      // non-directory entry on PATH makes node throw ENOTDIR synchronously.
      // `mapError` never sees that, so it would escape as an uncaught error.
      Effect.catchDefect((cause) =>
        Effect.fail(new TailscaleCommandSpawnError({ ...commandContext, cause })),
      ),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStdout(child.stdout),
        collectStderr(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError((cause) => new TailscaleCommandOutputError({ ...commandContext, cause })),
    );
    if (exitCode !== 0) {
      return yield* new TailscaleCommandExitError({
        ...commandContext,
        exitCode,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        ...(stderrDiagnosticOf(stderr) !== undefined
          ? { stderrDiagnostic: stderrDiagnosticOf(stderr) }
          : {}),
      });
    }
    return stdout;
  }).pipe(
    Effect.scoped,
    Effect.timeout(TAILSCALE_STATUS_TIMEOUT),
    Effect.catchTags({
      TimeoutError: (cause) =>
        Effect.fail(
          new TailscaleCommandTimeoutError({
            ...commandContext,
            timeoutMs: Duration.toMillis(TAILSCALE_STATUS_TIMEOUT),
            cause,
          }),
        ),
    }),
  );
});

export const readTailscaleStatus = readTailscaleOutput("status", ["status", "--json"]).pipe(
  Effect.flatMap(parseTailscaleStatus),
);

const TailscaleExitNodeJson = Schema.Struct({
  ExitNodeStatus: Schema.optional(Schema.Struct({ Online: Schema.optional(Schema.Unknown) })),
  Peer: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        ExitNode: Schema.optional(Schema.Unknown),
        HostName: Schema.optional(Schema.Unknown),
        DNSName: Schema.optional(Schema.Unknown),
      }),
    ),
  ),
});

const decodeTailscaleExitNodeJson = Schema.decodeEffect(
  Schema.fromJsonString(TailscaleExitNodeJson),
);

export interface TailscaleExitNode {
  readonly name: string | null;
  readonly online: boolean;
}

/**
 * `ExitNodeStatus` is present only while an exit node is in use, but it has no
 * name. The name comes from the peer marked `ExitNode: true`.
 */
export const parseTailscaleExitNode = (
  rawStatusJson: string,
): Effect.Effect<TailscaleExitNode | null, TailscaleStatusParseError> =>
  decodeTailscaleExitNodeJson(rawStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map((parsed) => {
      if (parsed.ExitNodeStatus === undefined) return null;
      const peer = Object.values(parsed.Peer ?? {}).find(
        (candidate) => candidate.ExitNode === true,
      );
      // The DNS label is the tailnet machine name; HostName is the OS name and ignores renames.
      const dnsLabel = typeof peer?.DNSName === "string" ? (peer.DNSName.split(".")[0] ?? "") : "";
      const hostName = typeof peer?.HostName === "string" ? peer.HostName.trim() : "";
      return {
        name: dnsLabel || hostName || null,
        online: parsed.ExitNodeStatus.Online === true,
      };
    }),
  );

export const readTailscaleExitNode = readTailscaleOutput("status", ["status", "--json"]).pipe(
  Effect.flatMap(parseTailscaleExitNode),
);

const TailscalePrefsJson = Schema.Struct({
  RunSSH: Schema.optional(Schema.Unknown),
  WantRunning: Schema.optional(Schema.Unknown),
});

const decodeTailscalePrefsJson = Schema.decodeEffect(Schema.fromJsonString(TailscalePrefsJson));

/**
 * `tailscale status --json` does not report this for the local node. `tailscale
 * down` clears WantRunning but keeps RunSSH, so check both.
 */
export const parseTailscaleSshEnabled = (
  rawPrefsJson: string,
): Effect.Effect<boolean, TailscaleStatusParseError> =>
  decodeTailscalePrefsJson(rawPrefsJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map((prefs) => prefs.RunSSH === true && prefs.WantRunning !== false),
  );

export const readTailscaleSshEnabled = readTailscaleOutput("debug", ["debug", "prefs"]).pipe(
  Effect.flatMap(parseTailscaleSshEnabled),
);

export function buildTailscaleHttpsBaseUrl(input: {
  readonly magicDnsName: string;
  readonly servePort?: number;
}): string {
  const url = new URL(`https://${input.magicDnsName}`);
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  if (servePort !== DEFAULT_TAILSCALE_SERVE_PORT) {
    url.port = String(servePort);
  }
  url.pathname = "/";
  return url.toString();
}

const runTailscaleCommand = Effect.fn("tailscale.runTailscaleCommand")(function* (
  args: readonly string[],
  timeoutInput: Duration.Input,
): Effect.fn.Return<string, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostPlatform = yield* HostProcess.Platform;
  const executable = tailscaleCommandForPlatform(hostPlatform);
  const commandContext = {
    executable,
    subcommand: "serve" as const,
    argumentCount: args.length,
  };
  const timeout = Duration.fromInputUnsafe(timeoutInput);
  return yield* Effect.gen(function* () {
    const child = yield* spawner
      .spawn(ChildProcess.make(executable, args, { forceKillAfter: TAILSCALE_KILL_GRACE }))
      .pipe(
        Effect.mapError((cause) => new TailscaleCommandSpawnError({ ...commandContext, cause })),
        Effect.catchDefect((cause) =>
          Effect.fail(new TailscaleCommandSpawnError({ ...commandContext, cause })),
        ),
      );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStdout(child.stdout),
        collectStderr(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError((cause) => new TailscaleCommandOutputError({ ...commandContext, cause })),
    );
    if (exitCode !== 0) {
      return yield* new TailscaleCommandExitError({
        ...commandContext,
        exitCode,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        ...(stderrDiagnosticOf(stderr) !== undefined
          ? { stderrDiagnostic: stderrDiagnosticOf(stderr) }
          : {}),
      });
    }
    return stdout;
  }).pipe(
    Effect.scoped,
    Effect.timeout(timeout),
    Effect.catchTags({
      TimeoutError: (cause) =>
        Effect.fail(
          new TailscaleCommandTimeoutError({
            ...commandContext,
            timeoutMs: Duration.toMillis(timeout),
            cause,
          }),
        ),
    }),
  );
});

type TailscaleServePortState =
  | "absent"
  | "exact"
  | "funnel"
  | "occupied"
  | { readonly proxy: string };

function authorityPort(authority: string): number | null {
  try {
    const url = new URL(`https://${authority}`);
    return url.port.length === 0 ? DEFAULT_TAILSCALE_SERVE_PORT : Number(url.port);
  } catch {
    return null;
  }
}

function servePortState(
  status: Omit<TailscaleServeStatusJson, "Services">,
  input: { readonly servePort: number; readonly proxy: string },
): TailscaleServePortState {
  // Foreground handlers belong to their CLI session and override background mappings.
  if (
    Object.values(status.Foreground ?? {}).some(
      (config) =>
        Object.keys(config.TCP ?? {}).some((port) => Number(port) === input.servePort) ||
        Object.keys(config.Web ?? {}).some(
          (authority) => authorityPort(authority) === input.servePort,
        ) ||
        Object.entries(config.AllowFunnel ?? {}).some(
          ([authority, enabled]) => authorityPort(authority) === input.servePort && enabled,
        ),
    )
  ) {
    return "occupied";
  }
  const tcpEntries = Object.entries(status.TCP ?? {}).filter(
    ([port]) => Number(port) === input.servePort,
  );
  const entries = Object.entries(status.Web ?? {}).filter(
    ([authority]) => authorityPort(authority) === input.servePort,
  );
  const funnelEnabled = Object.entries(status.AllowFunnel ?? {}).some(
    ([authority, enabled]) => authorityPort(authority) === input.servePort && enabled,
  );
  if (funnelEnabled) {
    return "funnel";
  }
  if (entries.length === 0 && tcpEntries.length === 0) {
    return "absent";
  }
  if (entries.length !== 1 || tcpEntries.length !== 1) {
    return "occupied";
  }
  const tcp = tcpEntries[0]?.[1];
  if (tcp?.HTTPS !== true || tcp.TCPForward !== undefined) {
    return "occupied";
  }

  const handlers = entries[0]?.[1].Handlers;
  if (handlers === undefined || Object.keys(handlers).length !== 1) {
    return "occupied";
  }
  const root = handlers["/"];
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    return "occupied";
  }
  const proxy = Reflect.get(root, "Proxy");
  if (typeof proxy !== "string" || Object.keys(root).length !== 1) return "occupied";
  return proxy === input.proxy ? "exact" : { proxy };
}

const readTailscaleServePortState = (input: {
  readonly servePort: number;
  readonly proxy: string;
}): Effect.Effect<
  TailscaleServePortState,
  TailscaleCommandError | TailscaleServePortOccupiedError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  runTailscaleCommand(["serve", "status", "--json"], TAILSCALE_STATUS_TIMEOUT).pipe(
    Effect.flatMap((stdout) =>
      Effect.gen(function* () {
        const raw = yield* decodeTailscaleServeStatusJson(stdout);
        if (raw === null) return "absent" as const;
        const config = yield* selectedServeConfig(
          { TCP: raw.TCP, Web: raw.Web, AllowFunnel: raw.AllowFunnel },
          input.servePort,
        );
        const foreground = yield* Effect.forEach(
          Object.entries(raw.Foreground ?? {}),
          ([name, value]) =>
            selectedServeConfig(value, input.servePort).pipe(
              Effect.map((config) => [name, config] as const),
            ),
        );
        return servePortState({ ...config, Foreground: Object.fromEntries(foreground) }, input);
      }).pipe(
        Effect.mapError(() => new TailscaleServePortOccupiedError({ servePort: input.servePort })),
      ),
    ),
  );

/** Checks the live configuration without changing handlers or probing HTTPS. */
export const hasExactTailscaleServe = (input: {
  readonly servePort: number;
  readonly proxy: string;
}) =>
  withServeRecord(input.servePort, (db) =>
    readRecordedServePortState(db, input).pipe(Effect.map(({ state }) => state === "exact")),
  );

const loopbackProxyTarget = (proxy: string) => {
  const match = /^http:\/\/(\[[^\]]+\]|[^:/]+):([1-9]\d*)$/u.exec(proxy);
  if (match === null) return undefined;
  const host = normalizeHostname(match[1]!);
  const port = Number(match[2]);
  return NodeNet.isIP(host) !== 0 && isLocalLoopbackHost(host) && port <= 65535
    ? { host, port }
    : undefined;
};

const isDeadLoopbackProxy = Effect.fn("tailscale.isDeadLoopbackProxy")(function* (proxy: string) {
  const target = loopbackProxyTarget(proxy);
  if (target === undefined) return false;
  return yield* Effect.callback<boolean>((resume) => {
    const socket = NodeNet.createConnection({ host: target.host, port: target.port });
    const settle = (dead: boolean) => {
      socket.destroy();
      resume(Effect.succeed(dead));
    };
    socket.unref();
    socket.once("connect", () => settle(false));
    socket.once("timeout", () => settle(false));
    socket.once("error", (error) => {
      const failures: readonly unknown[] = error instanceof AggregateError ? error.errors : [error];
      settle(
        failures.length > 0 &&
          failures.every(
            (cause) =>
              typeof cause === "object" &&
              cause !== null &&
              Reflect.get(cause, "code") === "ECONNREFUSED",
          ),
      );
    });
    socket.setTimeout(250);
    return Effect.sync(() => socket.destroy());
  }).pipe(Effect.catchDefect(() => Effect.succeed(false)));
});

const withServeRecord = Effect.fn("tailscale.withServeRecord")(function* <A, E, R>(
  servePort: number,
  operation: (db: NodeSqlite.DatabaseSync) => Effect.Effect<A, E, R>,
) {
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const env = yield* HostProcess.Environment;
  const base =
    platform === "win32"
      ? env.LOCALAPPDATA || NodePath.join(home, "AppData", "Local")
      : platform === "darwin"
        ? NodePath.join(home, "Library", "Application Support")
        : env.XDG_STATE_HOME && NodePath.isAbsolute(env.XDG_STATE_HOME)
          ? env.XDG_STATE_HOME
          : NodePath.join(home, ".local", "state");
  const directory = NodePath.join(base, "styal");
  yield* Effect.try({
    try: () => NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 }),
    catch: (cause) => new TailscaleServeRecordError({ stage: "directory", cause }),
  });
  const path = NodePath.join(directory, `tailscale-serve-${servePort}.sqlite`);
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => new NodeSqlite.DatabaseSync(`${path}.lock`),
      catch: (cause) => new TailscaleServeRecordError({ stage: "open", cause }),
    }),
    (lock) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => lock.exec("BEGIN EXCLUSIVE"),
          catch: (cause) =>
            typeof cause === "object" &&
            cause !== null &&
            [5, 6].includes(Number(Reflect.get(cause, "errcode")))
              ? new TailscaleServeRecoveryBusyError({ servePort })
              : new TailscaleServeRecordError({ stage: "lock", cause }),
        });
        return yield* Effect.acquireUseRelease(
          Effect.try({
            try: () => new NodeSqlite.DatabaseSync(path),
            catch: (cause) => new TailscaleServeRecordError({ stage: "open", cause }),
          }),
          (db) =>
            Effect.gen(function* () {
              // Autocommit invalidation survives a crash between the daemon write and recording its result.
              yield* serveRecordSql(() =>
                db.exec(
                  "CREATE TABLE IF NOT EXISTS ownership (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), proxy TEXT NOT NULL, managed INTEGER NOT NULL CHECK (managed IN (0, 1)))",
                ),
              );
              return yield* operation(db);
            }),
          (db) => Effect.sync(() => db.close()),
        );
      }),
    (lock) => Effect.sync(() => lock.close()),
  );
});

const serveRecordSql = <A>(operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (cause) => new TailscaleServeRecordError({ stage: "record", cause }),
  });

const readRecordedServePortState = Effect.fn("tailscale.readRecordedServePortState")(function* (
  db: NodeSqlite.DatabaseSync,
  input: { readonly servePort: number; readonly proxy: string },
) {
  const observed = yield* readTailscaleServePortState(input).pipe(Effect.result);
  const forget = serveRecordSql(() => db.exec("DELETE FROM ownership"));
  if (observed._tag === "Failure") {
    if (observed.failure._tag === "TailscaleServePortOccupiedError") yield* forget;
    return yield* observed.failure;
  }
  const state = observed.success;
  const record = yield* serveRecordSql(() =>
    db.prepare("SELECT proxy, managed FROM ownership WHERE singleton = 1").get(),
  );
  const current =
    state === "exact" ? input.proxy : typeof state === "object" ? state.proxy : undefined;
  if (
    record?.proxy !== current ||
    state === "absent" ||
    state === "funnel" ||
    state === "occupied"
  ) {
    yield* forget;
    return { state, record: undefined };
  }
  return { state, record };
});

export const ensureTailscaleServe = Effect.fn("tailscale.ensureTailscaleServe")(function* (input: {
  readonly localPort: number;
  readonly servePort?: number;
  readonly localHost?: string;
  /** The caller has already verified that the current handler fronts this exact T3 environment. */
  readonly replaceVerifiedHandler?: boolean;
  /** Only server-managed writes may be recovered; pairing and dev-share writes stay persistent. */
  readonly reclaimDeadHandler?: boolean;
  readonly previousDeadProxy?: string | undefined;
  /** Repair leaves an intentionally removed route absent. */
  readonly repairOnly?: boolean;
}): Effect.fn.Return<
  string | undefined,
  TailscaleServeError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const proxy = `http://${input.localHost ?? "127.0.0.1"}:${input.localPort}`;
  return yield* withServeRecord(servePort, (db) =>
    Effect.gen(function* () {
      const forget = serveRecordSql(() => db.exec("DELETE FROM ownership"));
      const { state, record } = yield* readRecordedServePortState(db, { servePort, proxy });
      if (state === "funnel" || state === "occupied")
        return yield* new TailscaleServePortOccupiedError({ servePort });
      if (state === "exact") {
        if (record?.proxy === proxy && input.reclaimDeadHandler !== true) {
          yield* serveRecordSql(() =>
            db.exec("UPDATE ownership SET managed = 0 WHERE singleton = 1"),
          );
        }
        return undefined;
      }
      if (state === "absent" && input.repairOnly) return undefined;
      if (typeof state === "object" && input.replaceVerifiedHandler !== true) {
        if (
          input.reclaimDeadHandler !== true ||
          record?.proxy !== state.proxy ||
          record.managed !== 1
        ) {
          return yield* new TailscaleServePortOccupiedError({ servePort, unrecorded: true });
        }
        if (loopbackProxyTarget(state.proxy) === undefined)
          return yield* new TailscaleServePortOccupiedError({ servePort });
        if (!(yield* isDeadLoopbackProxy(state.proxy)))
          return yield* new TailscaleServePortOccupiedError({ servePort });
        if (input.previousDeadProxy !== state.proxy) return state.proxy;
      }
      yield* forget;
      yield* runTailscaleCommand(
        ["serve", "--bg", `--https=${servePort}`, proxy],
        TAILSCALE_SERVE_TIMEOUT,
      );
      if (typeof state === "object" && input.reclaimDeadHandler === true) {
        yield* Effect.logWarning(
          "Tailscale Serve takeover command succeeded for a recorded mapping after two refused checks",
          { servePort, replacedProxy: state.proxy, proxy },
        );
      }
      if (
        input.reclaimDeadHandler === true &&
        (yield* readTailscaleServePortState({ servePort, proxy })) !== "exact"
      ) {
        return yield* new TailscaleServeNotConfiguredError({ servePort });
      }
      yield* serveRecordSql(() =>
        db
          .prepare("INSERT OR REPLACE INTO ownership (singleton, proxy, managed) VALUES (1, ?, ?)")
          .run(proxy, input.reclaimDeadHandler === true ? 1 : 0),
      );
      return undefined;
    }),
  );
});

export const repairTailscaleServe = Effect.fn("tailscale.repairTailscaleServe")(function* (input: {
  readonly localPort: number;
  readonly servePort: number;
  readonly localHost: string;
  readonly previousDeadProxy?: string | undefined;
}) {
  let previousDeadProxy = input.previousDeadProxy;
  return yield* Effect.sleep("30 seconds").pipe(
    Effect.andThen(
      Effect.suspend(() =>
        ensureTailscaleServe({
          ...input,
          previousDeadProxy,
          reclaimDeadHandler: true,
          repairOnly: true,
        }),
      ),
    ),
    Effect.match({
      onFailure: () => {
        previousDeadProxy = undefined;
      },
      onSuccess: (candidate) => {
        previousDeadProxy = candidate;
      },
    }),
    Effect.forever,
  );
});

/** A Serve route: a web handler at `mount` on `servePort`, or a TCP forward without one. */
export interface TailscaleServeRoute {
  readonly servePort: number;
  readonly mount?: string;
  /** The machine name a web route serves under. */
  readonly host?: string;
  /** A target, such as a name, that may dial this server or another service on the same port. */
  readonly ambiguous?: string;
  /** The Tailscale Service it belongs to, or `foreground` for a `tailscale serve` still running. */
  readonly owner?: string;
}

/**
 * The `tailscale` arguments that turn `route` off; a foreground route has none, since it ends with
 * its command. A web route names its path: without one the CLI removes every handler on the port,
 * and answers its own confirmation prompt with yes when nobody is there to answer.
 */
export const tailscaleServeOffArgs = (
  route: TailscaleServeRoute,
): ReadonlyArray<string> | undefined =>
  route.owner === "foreground"
    ? undefined
    : [
        "serve",
        ...(route.owner === undefined ? [] : [`--service=${route.owner}`]),
        ...(route.mount === undefined
          ? [`--tcp=${route.servePort}`]
          : [`--https=${route.servePort}`, `--set-path=${route.mount}`]),
        "off",
      ];

/** Removes the handler `ensureTailscaleServe` added, and refuses when the port holds anything else. */
export const disableTailscaleServe = Effect.fn("tailscale.disableTailscaleServe")(
  function* (input: {
    readonly servePort?: number;
    readonly localPort: number;
    readonly localHost?: string;
    readonly recordedOnly?: boolean;
  }): Effect.fn.Return<boolean, TailscaleServeError, ChildProcessSpawner.ChildProcessSpawner> {
    const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
    const proxy = `http://${input.localHost ?? "127.0.0.1"}:${input.localPort}`;
    return yield* withServeRecord(servePort, (db) =>
      Effect.gen(function* () {
        const forget = serveRecordSql(() => db.exec("DELETE FROM ownership"));
        const { state, record } = yield* readRecordedServePortState(db, { servePort, proxy });
        if (state === "absent") return false;
        if (state !== "exact") return yield* new TailscaleServePortOccupiedError({ servePort });
        if (input.recordedOnly && (record?.proxy !== proxy || record.managed !== 1)) return false;
        yield* forget;
        yield* runTailscaleCommand(
          ["serve", `--https=${servePort}`, "off"],
          TAILSCALE_SERVE_TIMEOUT,
        );
        return true;
      }),
    );
  },
);

/** Removes an explicitly selected route, invalidating ownership when its root goes. */
export const disableTailscaleServeRoute = Effect.fn("tailscale.disableTailscaleServeRoute")(
  function* (input: {
    readonly servePort: number;
    readonly mount: string;
  }): Effect.fn.Return<void, TailscaleServeError, ChildProcessSpawner.ChildProcessSpawner> {
    const remove = runTailscaleCommand(tailscaleServeOffArgs(input)!, TAILSCALE_SERVE_TIMEOUT);
    if (input.mount !== "/") {
      yield* remove;
      return;
    }
    yield* withServeRecord(input.servePort, (db) =>
      serveRecordSql(() => db.exec("DELETE FROM ownership")).pipe(Effect.andThen(remove)),
    );
  },
);

/** Removes a TCP forward on `servePort`; one port holds one forward, so nothing else goes. */
export const disableTailscaleServeTcp = (servePort: number) =>
  withServeRecord(servePort, (db) =>
    serveRecordSql(() => db.exec("DELETE FROM ownership")).pipe(
      Effect.andThen(
        runTailscaleCommand(tailscaleServeOffArgs({ servePort })!, TAILSCALE_SERVE_TIMEOUT),
      ),
    ),
  );

// A node without any Serve configuration prints `null`.
const decodeTailscaleServeStatusOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.NullOr(TailscaleServeStatusJson)),
);

const handlerProxy = (handler: unknown) => {
  const proxy = typeof handler === "object" && handler !== null && Reflect.get(handler, "Proxy");
  return typeof proxy === "string" ? proxy : undefined;
};

/**
 * Whether a proxy to `hostname` dials `bindHost`. `0.0.0.0` reaches 127.0.0.1. `[::]` may reach
 * either loopback, since Go dials `::` and then 0.0.0.0 (golang/go#18806), and a name such as
 * `localhost` may resolve to whatever the server binds.
 */
const reaches = (hostname: string, bindHost: string): "exact" | "either" | undefined => {
  let address = normalizeHostname(hostname);
  // Compare IPv6 by value: 0:0:0:0:0:ffff:7f00:1 is ::ffff:7f00:1.
  if (address.includes(":") && URL.canParse(`http://[${address}]`)) {
    address = normalizeHostname(new URL(`http://[${address}]`).hostname);
  }
  // An IPv4-mapped address can be written as hex, such as ::ffff:7f00:1 for 127.0.0.1.
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/u.exec(address);
  if (mapped !== null) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    address = [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
  } else if (address.startsWith("::ffff:")) {
    address = address.slice("::ffff:".length);
  }
  // Strict, as Go's ParseIP is; anything else, such as `127.1` or `box.1`, goes to the resolver.
  const literal =
    address.includes(":") ||
    /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?!$)|$)){4}$/u.test(address);
  if (!literal) return "either";
  if (address === "::")
    return bindHost === "127.0.0.1" || bindHost === "::1" ? "either" : undefined;
  return (address === "0.0.0.0" ? "127.0.0.1" : address) === bindHost ? "exact" : undefined;
};

/** The URL Tailscale's proxy dials for a handler's `Proxy`, expanded as its `expandProxyArg` does. */
const expandProxy = (proxy: string) =>
  /^\d+$/u.test(proxy)
    ? `http://127.0.0.1:${proxy}`
    : proxy.startsWith("https+insecure://")
      ? `https://${proxy.slice("https+insecure://".length)}`
      : /^(?:https?:\/\/|unix:)/u.test(proxy)
        ? proxy
        : `http://${proxy}`;

/**
 * The host and port a proxy target dials, read as Go's url.Parse reads it rather than as a WHATWG
 * URL, which rejects `box.1` and rewrites `127.1`; none for a Unix socket.
 */
const dialedHostPort = (url: string) => {
  const match = /^(https?|tcp):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^/?#:]*)(?::(\d*))?/iu.exec(url);
  if (match === null) return undefined;
  const [, scheme = "", host = "", port] = match;
  return { host, port: port || (scheme.toLowerCase() === "https" ? "443" : "80") };
};

const reachesTarget = (url: string, target: { readonly host: string; readonly port: number }) => {
  const dialed = dialedHostPort(url);
  // Go reads the port as a decimal number, so 03773 is 3773.
  if (dialed === undefined || Number(dialed.port) !== target.port) return undefined;
  const reach = reaches(dialed.host, target.host);
  return reach === undefined ? undefined : { reach, hostname: dialed.host };
};

/**
 * The Serve routes that forward to the server bound at `target`, or undefined when the status
 * cannot be read.
 */
export const parseTailscaleServeRoutesTo = (
  rawServeStatusJson: string,
  target: { readonly host: string; readonly port: number },
): ReadonlyArray<TailscaleServeRoute> | undefined => {
  const status = decodeTailscaleServeStatusOption(rawServeStatusJson);
  if (Option.isNone(status)) return undefined;
  const routesIn = (
    config: typeof TailscaleServeConfigJson.Type | undefined,
    owner?: string,
  ): ReadonlyArray<TailscaleServeRoute> => {
    const scope = owner === undefined ? {} : { owner };
    const reached = (url: string) => {
      const found = reachesTarget(url, target);
      if (found === undefined) return undefined;
      return found.reach === "either" ? { ambiguous: found.hostname } : {};
    };
    const tcp = Object.entries(config?.TCP ?? {}).flatMap(([port, handler]) => {
      const reach =
        handler.TCPForward === undefined || handler.TCPForward.startsWith("unix:")
          ? undefined
          : reached(`tcp://${handler.TCPForward}`);
      return reach !== undefined && Number.isInteger(Number(port))
        ? [{ servePort: Number(port), ...reach, ...scope }]
        : [];
    });
    const web = Object.entries(config?.Web ?? {}).flatMap(([hostPort, site]) => {
      const separator = hostPort.lastIndexOf(":");
      const servePort = Number(hostPort.slice(separator + 1));
      if (!Number.isInteger(servePort)) return [];
      const host = hostPort.slice(0, separator);
      return Object.entries(site.Handlers ?? {}).flatMap(([mount, handler]) => {
        const proxy = handlerProxy(handler);
        const reach = proxy === undefined ? undefined : reached(expandProxy(proxy));
        return reach === undefined ? [] : [{ servePort, mount, host, ...reach, ...scope }];
      });
    });
    return [...tcp, ...web];
  };
  return [
    ...routesIn(status.value ?? undefined),
    ...Object.entries(status.value?.Services ?? {}).flatMap(([name, service]) =>
      routesIn(service, name),
    ),
    ...Object.values(status.value?.Foreground ?? {}).flatMap((session) =>
      routesIn(session, "foreground"),
    ),
  ];
};

/** The Serve routes that forward to the server bound at `target` on this machine. */
export const readTailscaleServeRoutesTo = (target: {
  readonly host: string;
  readonly port: number;
}) =>
  readTailscaleOutput("serve", ["serve", "status", "--json"]).pipe(
    Effect.flatMap((status) => {
      const routes = parseTailscaleServeRoutesTo(status, target);
      return routes === undefined
        ? Effect.fail(new TailscaleStatusParseError({ cause: "unreadable serve status" }))
        : Effect.succeed(routes);
    }),
  );

export const probeTailscaleHttpsEndpoint = Effect.fn("tailscale.probeTailscaleHttpsEndpoint")(
  function* (input: { readonly baseUrl: string; readonly timeout?: Duration.Input }) {
    const client = yield* HttpClient.HttpClient;
    const descriptor = yield* Effect.gen(function* () {
      const url = new URL("/.well-known/t3/environment", input.baseUrl);
      const response = yield* client
        .execute(HttpClientRequest.get(url.toString()))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      // A Serve mapping to another app also answers 2xx; only a T3 descriptor proves this server.
      return yield* HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)(response);
    }).pipe(Effect.timeoutOption(input.timeout ?? TAILSCALE_PROBE_TIMEOUT));

    return Option.isSome(descriptor);
  },
  Effect.orElseSucceed(() => false),
);
