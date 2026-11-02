/**
 * Error and Fatal log entries go through {@link AnalyticsService}, sharing its identity, opt-out
 * and delivery. The logger only queues the entry; building, scrubbing and rate limiting happen
 * on a background fiber so logging stays cheap.
 */
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";

import * as ErrorTracking from "@posthog/core/error-tracking";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";
import * as Predicate from "effect/Predicate";
import * as References from "effect/References";

import { AnalyticsService } from "./AnalyticsService.ts";

declare const __T3CODE_BUILD_CHANNEL__: "nightly" | "latest" | undefined;

export interface LoggedError {
  readonly level: "error" | "fatal";
  readonly message: unknown;
  readonly cause: Cause.Cause<unknown>;
  readonly span: string | undefined;
  /** Where the enclosing `Effect.fn` and span calls were made, innermost first. */
  readonly stackFrame?: References.StackFrame | undefined;
}

const SINK_CAPACITY = 100;

/** Error log entries waiting to be reported. Filled by {@link errorReportLogger}. */
export class ErrorReportSink extends Context.Service<
  ErrorReportSink,
  {
    readonly offer: (entry: LoggedError) => void;
    readonly drain: () => ReadonlyArray<LoggedError>;
    /** Stops accepting entries, for servers that do not report. */
    readonly close: () => void;
  }
>()("@styal/cli/telemetry/ErrorReporting/ErrorReportSink") {}

/** A bounded sink. Entries past capacity are dropped until the next drain. */
export const makeErrorReportSink = (capacity = SINK_CAPACITY): ErrorReportSink["Service"] => {
  // Undefined once closed, so queued errors and what they reference are released.
  let pending: Array<LoggedError> | undefined = [];
  return ErrorReportSink.of({
    offer: (entry) => {
      if (pending && pending.length < capacity) pending.push(entry);
    },
    drain: () => {
      const drained = pending ?? [];
      if (pending) pending = [];
      return drained;
    },
    close: () => {
      pending = undefined;
    },
  });
};

/** Queues Error and Fatal log entries. Interruptions are not errors. */
export const errorReportLogger = (sink: ErrorReportSink["Service"]) =>
  Logger.make<unknown, void>(({ logLevel, message, cause, fiber }) => {
    if (!LogLevel.isGreaterThanOrEqualTo(logLevel, "Error")) return;
    if (cause.reasons.length > 0 && Cause.hasInterruptsOnly(cause)) return;
    const span = fiber.cache.span;
    sink.offer({
      level: logLevel === "Fatal" ? "fatal" : "error",
      message,
      cause,
      span: span?._tag === "Span" ? span.name : undefined,
      stackFrame: fiber.getRef(References.CurrentStackFrame),
    });
  });

const ERROR_KEYS = ["cause", "error", "err", "defect"] as const;

/**
 * The thrown value a log entry is about: a defect or failure in the entry's
 * cause, else an error passed as a message argument, directly or as
 * `{ cause }`, `{ error }` and similar.
 */
function reportedValue(entry: LoggedError): unknown {
  const fromCause = (cause: Cause.Cause<unknown>) => {
    const defect = cause.reasons.find(Cause.isDieReason);
    if (defect) return defect.defect;
    return cause.reasons.find(Cause.isFailReason)?.error;
  };
  const fromValue = (value: unknown): unknown => {
    if (Cause.isCause(value)) return fromCause(value);
    if (value instanceof Error) return value;
    return undefined;
  };

  const direct = fromCause(entry.cause);
  if (direct !== undefined) return direct;
  const args = Array.isArray(entry.message) ? entry.message : [entry.message];
  for (const arg of args) {
    const value = fromValue(arg);
    if (value !== undefined) return value;
    if (Predicate.isObject(arg)) {
      for (const key of ERROR_KEYS) {
        const nested = fromValue((arg as Record<string, unknown>)[key]);
        if (nested !== undefined) return nested;
      }
    }
  }
  return undefined;
}

function logMessage(entry: LoggedError): string | undefined {
  const args = Array.isArray(entry.message) ? entry.message : [entry.message];
  return args.find(Predicate.isString);
}

const MAX_TEXT_LENGTH = 1_000;

export interface Scrubber {
  readonly text: (text: string) => string;
  readonly filename: (filename: string) => string;
}

// Folder names that describe styal or platform layout rather than a user's work.
const LAYOUT_SEGMENTS = new Set([
  "worktrees",
  "userdata",
  "logs",
  "node_modules",
  "dist",
  "src",
  "AppData",
  "Local",
  "Roaming",
  "Library",
  "Caches",
]);

// Roots whose paths name a user's projects; the first component after each root is scrubbed.
const PATH_ROOT = String.raw`~|\/(?:Users|home)\/<user>|[A-Za-z]:[\\\/]Users[\\\/]<user>|\/(?:root|Volumes|mnt|media|srv|tmp|private|var|workspaces)|[A-Za-z]:(?=[\\\/])|\\(?=\\[^\\\s])`;
const PATH_ROOT_AT_START = new RegExp(`^(?:${PATH_ROOT})(?=[\\\\/])`);
const URL_TOKEN = String.raw`\b[a-z][a-z0-9+.-]*:\/\/[^\s'"\x60<>]*`;
// A URL is matched first so its path is never read as a filesystem path.
const URL_OR_PATH = new RegExp(
  `(${URL_TOKEN})|(?<![\\w.~/\\\\])((?:${PATH_ROOT})[\\\\/][^\\s'"\\x60(),;<>|]*)`,
  "gi",
);
const QUOTED_PATHS = ['"', "`", "'"].map(
  (quote) => new RegExp(`${quote}((?:${PATH_ROOT})[\\\\/][^${quote}\\n]*)${quote}`, "g"),
);
// Long inputs are cut before scrubbing; a value split at this bound falls outside the final cap.
const MAX_SCRUB_INPUT_LENGTH = MAX_TEXT_LENGTH * 4;

const isDigit = (char: string | undefined) => char !== undefined && char >= "0" && char <= "9";

/** Keeps a final component's short extension and `:line:column` suffix. */
const scrubSegment = (segment: string, last: boolean) => {
  if (segment === "" || segment.startsWith(".") || LAYOUT_SEGMENTS.has(segment)) return segment;
  if (!last) return "<name>";
  let end = segment.length;
  for (;;) {
    let start = end;
    while (isDigit(segment[start - 1])) start -= 1;
    if (start === end || segment[start - 1] !== ":") break;
    end = start - 1;
  }
  const dot = segment.lastIndexOf(".", end - 1);
  const extension = dot > 0 ? segment.slice(dot, end) : "";
  return `<name>${/^\.[A-Za-z0-9]{1,5}$/.test(extension) ? extension : ""}${segment.slice(end)}`;
};

/** Scrubs a path that starts with a known root; the whole value is one path, spaces included. */
const scrubRootedPath = (path: string) => {
  const root = PATH_ROOT_AT_START.exec(path)?.[0];
  if (root === undefined) return path;
  const parts = path.slice(root.length).split(/([\\/])/);
  return (
    root +
    parts
      .map((part, index) =>
        index % 2 === 1 ? part : scrubSegment(part, index === parts.length - 1),
      )
      .join("")
  );
};

const scrubPathsInText = (value: string) => {
  let scrubbed = value;
  for (const quoted of QUOTED_PATHS) {
    scrubbed = scrubbed.replace(quoted, (match, path: string) =>
      match.replace(path, scrubRootedPath(path)),
    );
  }
  return scrubbed.replace(
    URL_OR_PATH,
    (match, url: string | undefined, path: string | undefined) => {
      if (url !== undefined) {
        return url.toLowerCase().startsWith("file://")
          ? `file://${scrubRootedPath(url.slice("file://".length))}`
          : url;
      }
      const trimmed = path?.replace(/[.:]+$/, "") ?? "";
      return scrubRootedPath(trimmed) + match.slice(trimmed.length);
    },
  );
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Removes values that identify a person, their work, or grant access: user names and folder
 * and file names in user paths, URL credentials and queries, emails and token-like strings.
 * App frame filenames become relative to `appRoot`; dependency frames start at `node_modules/`.
 */
export function makeScrubber(input: { readonly appRoot: string; readonly homeDir: string }) {
  const toPosix = (path: string) => path.replaceAll("\\", "/");
  const appRoot = toPosix(input.appRoot).replace(/\/+$/, "");
  const homeDir = toPosix(input.homeDir).replace(/\/+$/, "");
  const homePrefix =
    homeDir.length > 1
      ? new RegExp(
          `(?:${escapeRegExp(homeDir)}|${escapeRegExp(input.homeDir.replace(/[\\/]+$/, ""))})(?=$|[\\\\/\\s'"\\x60:),;])`,
          "g",
        )
      : undefined;

  const userPaths = (value: string) =>
    (homePrefix === undefined ? value : value.replace(homePrefix, "~")).replace(
      /(\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/])[^\\/\s'"`]+/g,
      "$1<user>",
    );

  const cap = (value: string) =>
    value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)}…` : value;

  const text = (value: string) =>
    cap(
      scrubPathsInText(userPaths(value.slice(0, MAX_SCRUB_INPUT_LENGTH)))
        .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, "$1<credentials>@")
        .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#'"`]*)\?[^\s#'"`]*/gi, "$1?<query>")
        .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
        .replace(/\b(bearer|basic)\s+[\w~+/=.-]+/gi, "$1 <redacted>")
        .replace(/\b[\w-]{32,}\b/g, "<redacted>"),
    );

  const filename = (value: string) => {
    const path = toPosix(value.startsWith("file://") ? value.slice("file://".length) : value);
    const dependency = path.lastIndexOf("/node_modules/");
    if (dependency !== -1) return path.slice(dependency + 1);
    if (appRoot.length > 0 && path.startsWith(`${appRoot}/`)) {
      return path.slice(appRoot.length + 1);
    }
    const userPath = userPaths(path.slice(0, MAX_SCRUB_INPUT_LENGTH));
    return PATH_ROOT_AT_START.test(userPath) ? cap(scrubRootedPath(userPath)) : text(path);
  };

  return { text, filename } satisfies Scrubber;
}

const exceptionBuilder = new ErrorTracking.ErrorPropertiesBuilder(
  [
    new ErrorTracking.ErrorCoercer(),
    new ErrorTracking.ObjectCoercer(),
    new ErrorTracking.StringCoercer(),
    new ErrorTracking.PrimitiveCoercer(),
  ],
  ErrorTracking.createStackParser("node:javascript", ErrorTracking.nodeStackLineParser),
);

/**
 * A stand-in error for a log entry without a thrown value. A stack captured in
 * the logger would show only the fiber runtime, so the stack comes from the
 * call sites Effect records for the enclosing `Effect.fn` and span calls.
 */
function loggedError(entry: LoggedError, message: string | undefined): Error {
  const error = new Error(message ?? "Error logged without a message");
  error.name = "LoggedError";
  const lines: Array<string> = [];
  for (let frame = entry.stackFrame; frame && lines.length < 50; frame = frame.parent) {
    const location = frame
      .stack()
      ?.trim()
      .split("\n")[0]
      ?.replace(/^at\s+/, "");
    if (location) lines.push(`    at ${frame.name} (${location})`);
  }
  // An empty stack makes the builder omit the stacktrace rather than send no frames.
  error.stack = lines.length === 0 ? "" : [`LoggedError: ${error.message}`, ...lines].join("\n");
  return error;
}

/**
 * The release the source map upload stamped into this bundle, so PostHog knows
 * which uploaded symbol sets resolve these frames. Read from the bundle only:
 * `ErrorTracking.getInjectedReleaseId` prefers a `POSTHOG_RELEASE_ID` variable,
 * which on a user's machine belongs to some other project.
 */
function injectedReleaseId(): string | undefined {
  const injected = (globalThis as { _posthogReleaseId?: unknown })._posthogReleaseId;
  return typeof injected === "string" && injected.length > 0 ? injected : undefined;
}

/**
 * Properties for a `$exception` event. A log entry without a thrown value is
 * reported under its message, so PostHog still groups it as an issue.
 */
export function exceptionProperties(entry: LoggedError, scrub: Scrubber) {
  const message = logMessage(entry);
  const value = reportedValue(entry);
  const { $exception_list } = exceptionBuilder.buildFromUnknown(
    value ?? loggedError(entry, message),
    { mechanism: { type: "logger", handled: true, synthetic: value === undefined } },
  );

  return {
    $exception_level: entry.level,
    $exception_list: $exception_list.map((exception) => ({
      ...exception,
      value: exception.value === undefined ? undefined : scrub.text(exception.value),
      ...(exception.stacktrace
        ? {
            stacktrace: {
              ...exception.stacktrace,
              frames: exception.stacktrace.frames?.map((frame) => {
                const { abs_path: _absPath, ...rest } = frame;
                return rest.filename === undefined
                  ? rest
                  : { ...rest, filename: scrub.filename(rest.filename) };
              }),
            },
          }
        : {}),
    })),
    logMessage: message === undefined ? undefined : scrub.text(message),
    span: entry.span,
    $release_id: injectedReleaseId(),
  };
}

// One runaway error must not flood delivery or the PostHog quota.
const RATE_WINDOW_MS = 60 * 60 * 1_000;
const MAX_REPORTS_PER_ISSUE = 3;
const MAX_REPORTS_PER_WINDOW = 30;
const DRAIN_INTERVAL = "1 second";

type ExceptionProperties = ReturnType<typeof exceptionProperties>;

/** A rough stand-in for PostHog's grouping, used only for rate limiting. */
function rateLimitKey(properties: ExceptionProperties): string {
  const [first] = properties.$exception_list;
  const frames = first?.stacktrace?.frames ?? [];
  const top = frames.findLast((frame) => frame.in_app) ?? frames.at(-1);
  return [
    first?.type,
    top ? `${top.filename}:${top.function}` : first?.value,
    properties.span,
  ].join("|");
}

/** Admits at most a few reports per issue, and per window overall. */
function makeRateLimiter() {
  let windowStart = 0;
  let total = 0;
  let perIssue = new Map<string, number>();
  return (key: string, now: number): boolean => {
    if (now - windowStart >= RATE_WINDOW_MS) {
      windowStart = now;
      total = 0;
      perIssue = new Map();
    }
    const issueCount = perIssue.get(key) ?? 0;
    if (total >= MAX_REPORTS_PER_WINDOW || issueCount >= MAX_REPORTS_PER_ISSUE) return false;
    total += 1;
    perIssue.set(key, issueCount + 1);
    return true;
  };
}

// Development servers would bury real reports, so only release builds report
// by default.
const isReleaseBuild = typeof __T3CODE_BUILD_CHANNEL__ !== "undefined";

const ErrorReportingConfig = Config.Boolean("T3CODE_ERROR_REPORTING_ENABLED").pipe(
  Config.withDefault(isReleaseBuild),
);

// The server package root, holding `src/` in development and `dist/` when bundled.
const APP_ROOT = NodeURL.fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "../.." : "..", import.meta.url),
);

/** Reports queued error log entries until the scope closes. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sink = yield* ErrorReportSink;
    if (!(yield* ErrorReportingConfig)) {
      sink.close();
      return;
    }
    const analytics = yield* AnalyticsService;
    const scrub = makeScrubber({ appRoot: APP_ROOT, homeDir: NodeOS.homedir() });
    const admit = makeRateLimiter();

    const report = Effect.gen(function* () {
      const entries = sink.drain();
      if (entries.length === 0) return;
      const now = yield* Clock.currentTimeMillis;
      for (const entry of entries) {
        const properties = exceptionProperties(entry, scrub);
        if (admit(rateLimitKey(properties), now)) {
          yield* analytics.record("$exception", properties);
        }
      }
    });

    yield* Effect.forever(Effect.sleep(DRAIN_INTERVAL).pipe(Effect.andThen(report)), {
      disableYield: true,
    }).pipe(Effect.forkScoped);
    // Runs before the analytics finalizer flushes, which is released later.
    yield* Effect.addFinalizer(() => report);
  }),
);
