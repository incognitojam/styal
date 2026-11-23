// @effect-diagnostics nodeBuiltinImport:off -- Recovery uses a native TCP probe, digest and per-account SQLite lock.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
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
  { servePort: Schema.Number },
) {
  override get message(): string {
    return `Tailscale Serve port ${this.servePort} is already configured by another handler.`;
  }
}

export type TailscaleServeError =
  | TailscaleCommandError
  | TailscaleStatusParseError
  | TailscaleServePortOccupiedError
  | TailscaleServeRecoveryError;

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
const decodeTailscaleServeStatusJson = Schema.decodeEffect(
  Schema.fromJsonString(Schema.NullOr(TailscaleServeStatusJson)),
);

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

type TailscaleServePortState = "absent" | "exact" | "funnel" | "occupied" | "replaceable";

function authorityPort(authority: string): number | null {
  try {
    const url = new URL(`https://${authority}`);
    return url.port.length === 0 ? DEFAULT_TAILSCALE_SERVE_PORT : Number(url.port);
  } catch {
    return null;
  }
}

function servePortState(
  status: TailscaleServeStatusJson,
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
  if (funnelEnabled) return "funnel";
  if (entries.length === 0 && tcpEntries.length === 0) {
    return "absent";
  }
  if (entries.length !== 1 || tcpEntries.length !== 1) {
    return "occupied";
  }
  const tcp = tcpEntries[0]?.[1];
  if (tcp?.HTTPS !== true) {
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
  return proxy === input.proxy ? "exact" : "replaceable";
}

const readTailscaleServePortState = (input: {
  readonly servePort: number;
  readonly proxy: string;
}): Effect.Effect<
  TailscaleServePortState,
  TailscaleCommandError | TailscaleStatusParseError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  runTailscaleCommand(["serve", "status", "--json"], TAILSCALE_STATUS_TIMEOUT).pipe(
    Effect.flatMap((stdout) =>
      decodeTailscaleServeStatusJson(stdout).pipe(
        Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
      ),
    ),
    Effect.map((status) => (status === null ? "absent" : servePortState(status, input))),
  );

/** Checks the live configuration without changing handlers or probing HTTPS. */
export const hasExactTailscaleServe = (input: {
  readonly servePort: number;
  readonly proxy: string;
}) => readTailscaleServePortState(input).pipe(Effect.map((state) => state === "exact"));

export const ensureTailscaleServe = (input: {
  readonly localPort: number;
  readonly servePort?: number;
  readonly localHost?: string;
  /** The caller has already verified that the current handler fronts this exact T3 environment. */
  readonly replaceVerifiedHandler?: boolean;
  readonly recoveryHome?: string;
  readonly previousDigest?: string | undefined;
}): Effect.Effect<
  string | undefined,
  TailscaleServeError,
  ChildProcessSpawner.ChildProcessSpawner
> => {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
  const localHost = input.localHost ?? "127.0.0.1";
  const proxy = `http://${localHost}:${input.localPort}`;
  return Effect.gen(function* () {
    const state = yield* readTailscaleServePortState({ servePort, proxy });
    if (state === "exact") {
      return;
    }
    if (
      state === "funnel" ||
      state === "occupied" ||
      (state === "replaceable" && input.replaceVerifiedHandler !== true)
    ) {
      if (input.recoveryHome !== undefined) {
        const next = yield* recoverTailscaleServe({
          home: input.recoveryHome,
          servePort,
          localPort: input.localPort,
          localHost,
          previousDigest: input.previousDigest,
        });
        return next === false ? yield* ensureTailscaleServe(input) : next;
      }
      return yield* new TailscaleServePortOccupiedError({ servePort });
    }
    yield* runTailscaleCommand(
      ["serve", "--bg", `--https=${servePort}`, proxy],
      TAILSCALE_SERVE_TIMEOUT,
    );
    if (input.recoveryHome !== undefined)
      yield* noteRecoveryWrite({ home: input.recoveryHome, servePort, proxy });
  });
};

export class TailscaleServeRecoveryError extends Schema.TaggedError<TailscaleServeRecoveryError>()(
  "TailscaleServeRecoveryError",
  {
    path: Schema.String,
    reason: Schema.Literals(["record", "busy", "ownership", "configuration", "live"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "live")
      return "Tailscale Serve backend is live or its availability is uncertain; leaving it unchanged. Wait or choose --tailscale-serve-port.";
    if (this.reason === "busy")
      return `Tailscale Serve recovery lock ${this.path} is busy; leaving the mapping unchanged.`;
    if (this.reason === "record")
      return `Cannot use Tailscale Serve recovery record ${this.path}; check its contents, permissions and available disk space. Recovery is off; choose --tailscale-serve-port or inspect and manually remove an unwanted mapping.`;
    return `Tailscale Serve recovery refused: its complete configuration or identity is unsupported or does not match what this styal home recorded in ${this.path}. Choose --tailscale-serve-port, or inspect and manually remove an unwanted mapping before restarting.`;
  }
}

const recoveryRoutes = {
  TCP: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        HTTPS: Schema.optional(Schema.Boolean),
        HTTP: Schema.optional(Schema.Boolean),
        TCPForward: Schema.optional(Schema.String),
        TerminateTLS: Schema.optional(Schema.String),
        ProxyProtocol: Schema.optional(Schema.Literals([0, 1, 2])),
      }),
    ),
  ),
  Web: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        Handlers: Schema.Record(
          Schema.String,
          Schema.Struct({
            Proxy: Schema.optional(Schema.String),
            Path: Schema.optional(Schema.String),
            Text: Schema.optional(Schema.String),
            Redirect: Schema.optional(Schema.String),
            AcceptAppCaps: Schema.optional(Schema.Array(Schema.String)),
          }),
        ),
      }),
    ),
  ),
};
const recoveryConfig = {
  ...recoveryRoutes,
  AllowFunnel: TailscaleServeConfigJson.fields.AllowFunnel,
  Services: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({ ...recoveryRoutes, Tun: Schema.optional(Schema.Boolean) }),
    ),
  ),
};
const decodeRecoveryConfig = Schema.decodeUnknownEffect(
  Schema.Struct({
    ...recoveryConfig,
    Foreground: Schema.optional(
      Schema.Record(
        Schema.String,
        Schema.Struct({
          ...recoveryConfig,
          Foreground: Schema.optional(Schema.Record(Schema.String, Schema.Never)),
        }),
      ),
    ),
  }),
  { onExcessProperty: "error" },
);
const decodeRecoveryIdentity = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      Self: Schema.Struct({ ID: Schema.NonEmptyString, DNSName: Schema.NonEmptyString }),
      CurrentTailnet: Schema.Struct({
        StableID: Schema.NonEmptyString,
        Name: Schema.NonEmptyString,
      }),
    }),
  ),
);
const decodeRecoveryReceipt = Schema.decodeUnknownEffect(
  Schema.Struct({ home: Schema.String, digest: Schema.String }),
  { onExcessProperty: "error" },
);
const recoveryPath = (home: string) => NodePath.join(home, "tailscale-serve-recovery.json");
const recoveryIo = <A>(path: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) => new TailscaleServeRecoveryError({ path, reason: "record", cause }),
  });
const canonicalJson = (value: unknown) =>
  JSON.stringify(value, (_, value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, Reflect.get(value, key)]),
        )
      : value,
  );

const readRecoverySnapshot = Effect.fn("tailscale.readRecoverySnapshot")(function* (
  input: {
    readonly home: string;
    readonly servePort: number;
  },
  observed?: string,
) {
  const raw =
    observed ??
    (yield* runTailscaleCommand(["serve", "status", "--json"], TAILSCALE_STATUS_TIMEOUT));
  const identity = yield* readTailscaleOutput("status", ["status", "--json"]).pipe(
    Effect.flatMap(decodeRecoveryIdentity),
    Effect.mapError(
      (cause) =>
        new TailscaleServeRecoveryError({
          path: recoveryPath(input.home),
          reason: "configuration",
          cause,
        }),
    ),
  );
  const status = yield* recoveryIo(recoveryPath(input.home), () => JSON.parse(raw) as unknown);
  const digest = NodeCrypto.createHash("sha256")
    .update(canonicalJson({ status, identity, servePort: input.servePort }))
    .digest("hex");
  return { raw, status, digest };
});

const withRecoveryLock = Effect.fn("tailscale.withRecoveryLock")(function* <A, E, R>(
  operation: Effect.Effect<A, E, R>,
) {
  const account = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  // Fixed account defaults keep XDG and LOCALAPPDATA overrides from splitting the lock.
  const base =
    platform === "win32"
      ? NodePath.join(account, "AppData", "Local")
      : platform === "darwin"
        ? NodePath.join(account, "Library", "Application Support")
        : NodePath.join(account, ".local", "state");
  const path = NodePath.join(base, "styal", "tailscale-serve-recovery.lock");
  const NodeSqlite = yield* Effect.tryPromise({
    try: () => import("node:sqlite"),
    catch: (cause) => new TailscaleServeRecoveryError({ path, reason: "record", cause }),
  });
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
        const db = new NodeSqlite.DatabaseSync(path);
        try {
          db.exec("BEGIN EXCLUSIVE");
          return db;
        } catch (error) {
          db.close();
          throw error;
        }
      },
      catch: (cause) =>
        new TailscaleServeRecoveryError({
          path,
          reason:
            typeof cause === "object" &&
            cause !== null &&
            [5, 6].includes(Number(Reflect.get(cause, "errcode")))
              ? "busy"
              : "record",
          cause,
        }),
    }),
    () => operation,
    (db) => Effect.sync(() => db.close()),
  );
});

const saveRecoveryReceipt = Effect.fn("tailscale.saveRecoveryReceipt")(function* (input: {
  readonly home: string;
  readonly servePort: number;
  readonly proxy: string;
}) {
  const snapshot = yield* readRecoverySnapshot(input);
  const parsed = yield* decodeTailscaleServeStatusJson(snapshot.raw).pipe(
    Effect.mapError(
      (cause) =>
        new TailscaleServeRecoveryError({
          path: recoveryPath(input.home),
          reason: "configuration",
          cause,
        }),
    ),
  );
  if (parsed === null || servePortState(parsed, input) !== "exact")
    return yield* new TailscaleServeRecoveryError({
      path: recoveryPath(input.home),
      reason: "ownership",
    });
  yield* recoveryIo(recoveryPath(input.home), () =>
    NodeFS.writeFileSync(
      recoveryPath(input.home),
      JSON.stringify({ home: NodeFS.realpathSync(input.home), digest: snapshot.digest }),
      { mode: 0o600, flush: true },
    ),
  );
});

const warnRecoveryRecord = (home: string) =>
  Effect.logWarning(
    "Tailscale Serve command completed, but its recovery record could not be saved",
    { path: recoveryPath(home) },
  );
const noteRecoveryWrite = (input: {
  readonly home: string;
  readonly servePort: number;
  readonly proxy: string;
}) =>
  withRecoveryLock(saveRecoveryReceipt(input)).pipe(
    Effect.catchCause(() => warnRecoveryRecord(input.home)),
  );
const forgetRecoveryReceipt = (home: string) =>
  recoveryIo(recoveryPath(home), () => {
    if (NodeFS.existsSync(recoveryPath(home)))
      NodeFS.writeFileSync(recoveryPath(home), "", { flush: true });
  });

const refusedRecoveryProxy = Effect.fn("tailscale.refusedRecoveryProxy")(function* (proxy: string) {
  const match = /^http:\/\/(\[[^\]]+\]|[^:/]+):([1-9]\d*)$/u.exec(proxy);
  if (match === null) return false;
  const host = match[1]!.startsWith("[") ? match[1]!.slice(1, -1) : match[1]!;
  const port = Number(match[2]);
  if (!NodeNet.isIP(host) || !isLocalLoopbackHost(host) || port > 65535) return false;
  return yield* Effect.callback<boolean>((resume) => {
    const socket = NodeNet.createConnection({ host, port });
    const settle = (value: boolean) => {
      socket.destroy();
      resume(Effect.succeed(value));
    };
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
    socket.unref();
    socket.setTimeout(250);
    return Effect.sync(() => socket.destroy());
  }).pipe(Effect.catchDefect(() => Effect.succeed(false)));
});

export const recoverTailscaleServe = Effect.fn("tailscale.recoverTailscaleServe")(
  function* (input: {
    readonly home: string;
    readonly servePort: number;
    readonly localPort: number;
    readonly localHost?: string;
    readonly previousDigest?: string | undefined;
  }) {
    const path = recoveryPath(input.home);
    const proxy = `http://${input.localHost ?? "127.0.0.1"}:${input.localPort}`;
    const state = yield* readTailscaleServePortState({ servePort: input.servePort, proxy });
    if (state === "exact" || state === "absent") return false as const;
    if (state !== "replaceable")
      return yield* new TailscaleServeRecoveryError({ path, reason: "configuration" });
    return yield* withRecoveryLock(
      Effect.gen(function* () {
        const raw = yield* runTailscaleCommand(
          ["serve", "status", "--json"],
          TAILSCALE_STATUS_TIMEOUT,
        );
        const parsed = yield* decodeTailscaleServeStatusJson(raw).pipe(
          Effect.mapError(
            (cause) => new TailscaleServeRecoveryError({ path, reason: "configuration", cause }),
          ),
        );
        const rechecked =
          parsed === null
            ? "absent"
            : servePortState(parsed, { servePort: input.servePort, proxy });
        if (rechecked === "absent" || rechecked === "exact") return false as const;
        const snapshot = yield* readRecoverySnapshot(input, raw);
        const receipt = yield* recoveryIo(
          path,
          () => JSON.parse(NodeFS.readFileSync(path, "utf8")) as unknown,
        ).pipe(
          Effect.mapError((error) =>
            typeof error.cause === "object" &&
            error.cause !== null &&
            Reflect.get(error.cause, "code") === "ENOENT"
              ? new TailscaleServeRecoveryError({ path, reason: "ownership" })
              : error,
          ),
          Effect.flatMap((raw) =>
            decodeRecoveryReceipt(raw).pipe(
              Effect.mapError(
                (cause) => new TailscaleServeRecoveryError({ path, reason: "record", cause }),
              ),
            ),
          ),
        );
        const home = yield* recoveryIo(path, () => NodeFS.realpathSync(input.home));
        if (receipt.home !== home || receipt.digest !== snapshot.digest)
          return yield* new TailscaleServeRecoveryError({ path, reason: "ownership" });
        const config = yield* decodeRecoveryConfig(snapshot.status).pipe(
          Effect.mapError(
            (cause) => new TailscaleServeRecoveryError({ path, reason: "configuration", cause }),
          ),
        );
        if (servePortState(config, { servePort: input.servePort, proxy }) !== "replaceable")
          return yield* new TailscaleServeRecoveryError({ path, reason: "configuration" });
        const [site] = Object.entries(config.Web ?? {}).filter(
          ([authority]) => authorityPort(authority) === input.servePort,
        );
        const root = site?.[1].Handlers["/"];
        const tcp = config.TCP?.[String(input.servePort)];
        if (
          !root?.Proxy ||
          Object.keys(root).length !== 1 ||
          !tcp ||
          Object.keys(tcp).length !== 1 ||
          tcp.HTTPS !== true
        )
          return yield* new TailscaleServeRecoveryError({ path, reason: "configuration" });
        if (!(yield* refusedRecoveryProxy(root.Proxy)))
          return yield* new TailscaleServeRecoveryError({ path, reason: "live" });
        if (input.previousDigest !== snapshot.digest) return snapshot.digest;
        yield* forgetRecoveryReceipt(input.home);
        yield* runTailscaleCommand(
          ["serve", "--bg", `--https=${input.servePort}`, proxy],
          TAILSCALE_SERVE_TIMEOUT,
        );
        yield* Effect.logWarning(
          "Tailscale Serve takeover command succeeded after two refused checks",
          { replacedProxy: root.Proxy, proxy, servePort: input.servePort },
        );
        yield* saveRecoveryReceipt({ ...input, proxy }).pipe(
          Effect.catchCause(() => warnRecoveryRecord(input.home)),
        );
        return undefined;
      }),
    );
  },
);

export const repairTailscaleServe = Effect.fn("tailscale.repairTailscaleServe")(function* (input: {
  readonly home: string;
  readonly servePort: number;
  readonly localPort: number;
  readonly localHost: string;
  readonly previousDigest?: string | undefined;
}) {
  let previousDigest = input.previousDigest;
  return yield* Effect.sleep("30 seconds").pipe(
    Effect.andThen(Effect.suspend(() => recoverTailscaleServe({ ...input, previousDigest }))),
    Effect.match({
      onSuccess: (next) => {
        previousDigest = typeof next === "string" ? next : undefined;
      },
      onFailure: () => {
        previousDigest = undefined;
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
    readonly recoveryHome?: string;
  }): Effect.fn.Return<void, TailscaleServeError, ChildProcessSpawner.ChildProcessSpawner> {
    const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
    const localHost = input.localHost ?? "127.0.0.1";
    const proxy = `http://${localHost}:${input.localPort}`;
    const state = yield* readTailscaleServePortState({ servePort, proxy });
    if (state === "absent") {
      return;
    }
    if (state === "occupied" || state === "funnel" || state === "replaceable") {
      return yield* new TailscaleServePortOccupiedError({ servePort });
    }
    yield* runTailscaleCommand(["serve", `--https=${servePort}`, "off"], TAILSCALE_SERVE_TIMEOUT);
    if (input.recoveryHome !== undefined)
      yield* forgetRecoveryReceipt(input.recoveryHome).pipe(
        Effect.catchCause(() =>
          Effect.logWarning(
            "Tailscale Serve removed, but its recovery record could not be cleared",
            { path: recoveryPath(input.recoveryHome!) },
          ),
        ),
      );
  },
);

/** Removes the web handler at `mount` on `servePort` without reading what the port holds. */
export const disableTailscaleServeRoute = Effect.fn("tailscale.disableTailscaleServeRoute")(
  function* (input: {
    readonly servePort: number;
    readonly mount: string;
  }): Effect.fn.Return<void, TailscaleCommandError, ChildProcessSpawner.ChildProcessSpawner> {
    yield* runTailscaleCommand(tailscaleServeOffArgs(input)!, TAILSCALE_SERVE_TIMEOUT);
  },
);

/** Removes a TCP forward on `servePort`; one port holds one forward, so nothing else goes. */
export const disableTailscaleServeTcp = (servePort: number) =>
  runTailscaleCommand(tailscaleServeOffArgs({ servePort })!, TAILSCALE_SERVE_TIMEOUT);

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
