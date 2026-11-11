import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ServerStartupStatus, type ServerStartupCopyProgress } from "@t3tools/contracts";

const decodeStatus = Schema.decodeUnknownOption(Schema.fromJsonString(ServerStartupStatus));

function describeReadinessCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    const tag = (cause as { readonly _tag?: unknown })._tag;
    const nested = (cause as { readonly cause?: unknown }).cause;
    return {
      ...(typeof tag === "string" ? { _tag: tag } : { name: cause.name }),
      message: cause.message,
      ...(nested === undefined ? {} : { cause: describeReadinessCause(nested) }),
    };
  }
  if (typeof cause !== "object" || cause === null) {
    return cause;
  }

  const record = cause as Readonly<Record<string, unknown>>;
  return {
    ...(typeof record._tag === "string" ? { _tag: record._tag } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(record.reason === undefined ? {} : { reason: describeReadinessCause(record.reason) }),
    ...(record.cause === undefined ? {} : { cause: describeReadinessCause(record.cause) }),
  };
}

export const waitForHttpReady = Effect.fn("shared.httpReadiness.waitForHttpReady")(function* <
  E,
>(input: {
  readonly baseUrl: string;
  readonly path?: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly onStartupCopy?: (progress: ServerStartupCopyProgress) => Effect.Effect<void>;
  readonly makeError: (info: {
    readonly requestUrl: string;
    readonly probeTimeoutMs: number;
    readonly attempt: number;
    readonly cause: unknown;
  }) => E;
}) {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const intervalMs = input.intervalMs ?? 100;
  const probeTimeoutMs = input.probeTimeoutMs ?? 1000;
  const requestUrl = new URL(input.path ?? "/", input.baseUrl).toString();
  const client = yield* HttpClient.HttpClient;
  const clock = yield* Clock.Clock;
  const now = () => Number(clock.monotonicTimeNanosUnsafe() / 1_000_000n);
  let deadline = now() + timeoutMs;
  let copying = false;
  let attempt = 0;
  let cause: unknown;
  yield* Effect.logDebug("httpReadiness.start", {
    requestUrl,
    timeoutMs,
    intervalMs,
    probeTimeoutMs,
  });
  while (now() < deadline || copying) {
    attempt++;
    const result = yield* Effect.gen(function* () {
      const response = yield* client.get(requestUrl);
      const text = yield* response.text;
      if (response.status >= 200 && response.status < 300) return { ready: true, copy: null };
      cause = { kind: "http-status", status: response.status };
      let copy: ServerStartupCopyProgress | null = null;
      const status = decodeStatus(text);
      if (Option.isSome(status) && status.value.copy !== null && status.value.copy.leaseMs > 0) {
        copy = status.value.copy;
      }
      return { ready: false, copy };
    }).pipe(
      Effect.timeoutOption(Math.min(probeTimeoutMs, Math.max(1, deadline - now()))),
      Effect.tap((result) =>
        Effect.sync(() => {
          if (Option.isNone(result)) cause = { kind: "probe-timeout", attempt, probeTimeoutMs };
        }),
      ),
      Effect.catch((error) => {
        cause = error;
        return Effect.succeedNone;
      }),
    );
    if (Option.isSome(result)) {
      if (result.value.ready) {
        yield* Effect.logDebug("httpReadiness.succeeded", { requestUrl, attempts: attempt });
        return;
      }
      if (result.value.copy !== null) {
        copying = true;
        // Leave one probe to observe normal startup after the byte watchdog expires.
        deadline = now() + result.value.copy.leaseMs + probeTimeoutMs + intervalMs;
        yield* input.onStartupCopy?.(result.value.copy) ?? Effect.void;
      } else if (copying) {
        copying = false;
        deadline = now() + timeoutMs;
      }
    }
    if (now() >= deadline) break;
    yield* Effect.sleep(
      Math.min(copying ? Math.max(1000, intervalMs) : intervalMs, Math.max(0, deadline - now())),
    );
  }
  yield* Effect.logWarning("httpReadiness.timedOut", {
    requestUrl,
    attempts: attempt,
    cause: describeReadinessCause(cause),
  });
  return yield* Effect.fail(
    input.makeError({
      requestUrl,
      probeTimeoutMs,
      attempt,
      cause: {
        kind: "overall-timeout",
        baseUrl: input.baseUrl,
        timeoutMs,
        lastFailure: { attempt, cause },
      },
    }),
  );
});
