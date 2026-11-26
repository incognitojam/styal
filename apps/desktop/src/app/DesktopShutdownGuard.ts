import { msg } from "gt-i18n";
import { m } from "../i18n/messages.ts";
import { describeHostActivity } from "@t3tools/shared/hostActivityCopy";
import { HostActivity, PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import type { HostActivityCheck } from "@t3tools/shared/hostActivity";
import * as Mac from "effect/crypto/Mac";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopShutdownConfirmation from "./DesktopShutdownConfirmation.ts";

export type ShutdownAction = "quit" | "restart";
export type ActivityCheck = HostActivityCheck | null;
export type ShutdownOptions = {
  readonly title?: string;
  /**
   * The same backends start again afterwards, so threads the server reports as
   * continuable resume. False for restarts that turn off or replace a backend.
   */
  readonly continueThreads?: boolean;
};

export function shutdownConfirmation(
  checks: ReadonlyArray<ActivityCheck>,
  action: ShutdownAction,
  { title, continueThreads = true }: ShutdownOptions = {},
) {
  const { concern, lines, incomplete, interrupts, threadActivity } = describeHostActivity(
    checks,
    {
      uncheckedHostsLine: m(msg("Could not check every local environment for running work.")),
      continueRunningThreads: continueThreads,
      continuesWhen: action === "quit" ? "when styal next starts" : "after the restart",
      includeListedThreadCounts: action === "quit",
    },
    (message) => m(message),
  );
  if (concern === null || (action === "restart" && !interrupts)) return null;
  const detail = incomplete
    ? [
        ...lines,
        "",
        m(
          action === "quit"
            ? msg("Quitting will stop any work hosted by this app.")
            : msg("Restarting will stop any work hosted by this app."),
        ),
      ]
    : lines;
  return {
    message:
      title ??
      m(
        action === "quit"
          ? concern === "running"
            ? msg("Quit with running work?")
            : concern === "waiting"
              ? msg("Quit with waiting threads?")
              : msg("Quit?")
          : concern === "running"
            ? msg("Restart with running work?")
            : concern === "waiting"
              ? msg("Restart with waiting threads?")
              : msg("Restart?"),
      ),
    detail: [
      detail.join("\n"),
      ...(interrupts ? [m(msg("Make sure you're ready before continuing."))] : []),
    ]
      .filter(Boolean)
      .join(" "),
    confirmLabel: m(action === "quit" ? msg("Quit") : msg("Restart")),
    ...(threadActivity.length ? { threadActivity } : {}),
  };
}

export class DesktopShutdownGuard extends Context.Service<
  DesktopShutdownGuard,
  {
    readonly confirm: (action: ShutdownAction, options?: ShutdownOptions) => Effect.Effect<boolean>;
    /** Activity of every owned backend; null for a host that could not be checked. */
    readonly inspect: Effect.Effect<ReadonlyArray<ActivityCheck>>;
  }
>()("@t3tools/desktop/app/DesktopShutdownGuard") {}

const make = Effect.gen(function* () {
  const mac = yield* Mac.Mac;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const localAuth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
  const http = yield* HttpClient.HttpClient;
  const dialog = yield* DesktopShutdownConfirmation.DesktopShutdownConfirmation;
  const tokens = new Map<string, { credential: string; bearer: string; expiresAt: number }>();
  let pending = false;
  const inspect = Effect.gen(function* () {
    const instances = yield* pool.list;
    return yield* Effect.forEach(
      instances,
      (instance) =>
        Effect.gen(function* () {
          const snapshot = yield* instance.snapshot;
          if (!snapshot.desiredRunning && Option.isNone(snapshot.activePid)) {
            return {
              activeSessions: 0,
              continuableSessions: 0,
              waitingSessions: 0,
              terminalsRequiringConfirmation: 0,
              terminalsWithUnknownActivity: 0,
            };
          }
          const option = yield* instance.currentConfig;
          if (Option.isNone(option)) return null;
          const config = option.value;
          const key = config.httpBaseUrl.href;
          let bearer: string;
          if (instance.id === PRIMARY_LOCAL_ENVIRONMENT_ID) {
            // A second desktop exchange revokes the primary renderer's bearer.
            bearer = yield* localAuth.getBearerToken;
          } else {
            // A backend launched with the desktop secret only accepts the
            // current window's token; the one in its launch config expires.
            const secret = config.bootstrap.desktopBootstrapSecret;
            const credential = secret ?? config.bootstrap.desktopBootstrapToken;
            if (!credential) return null;
            let token = tokens.get(key);
            const now = yield* Clock.currentTimeMillis;
            if (!token || token.credential !== credential || token.expiresAt <= now) {
              const session = yield* bootstrapRemoteBearerSession({
                httpBaseUrl: key,
                credential:
                  secret === undefined
                    ? credential
                    : yield* currentDesktopBootstrapToken(secret, now).pipe(
                        Effect.provideService(Mac.Mac, mac),
                      ),
                clientMetadata: { label: "Desktop shutdown check", deviceType: "desktop" },
              }).pipe(Effect.provideService(HttpClient.HttpClient, http));
              token = {
                credential,
                bearer: session.access_token,
                expiresAt: now + Math.max(0, session.expires_in - 5) * 1000,
              };
              tokens.set(key, token);
            }
            bearer = token.bearer;
          }
          const response = yield* http.execute(
            HttpClientRequest.get(new URL("/api/environment/activity", key).href).pipe(
              HttpClientRequest.bearerToken(bearer),
            ),
          );
          if (response.status !== 200) {
            tokens.delete(key);
            return null;
          }
          const activity = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(HostActivity)),
          );
          return {
            ...activity,
            ...(instances.length > 1 ? { hostLabel: yield* instance.label } : {}),
          };
        }).pipe(
          Effect.timeout("3 seconds"),
          Effect.catchCause(() => Effect.succeed(null)),
        ),
      { concurrency: "unbounded" },
    );
  });
  return DesktopShutdownGuard.of({
    inspect,
    confirm: Effect.fn("desktop.shutdown.confirm")(function* (action, options) {
      if (pending) return false;
      if (action === "quit" && (yield* dialog.consumeQuitOverride)) return true;
      pending = true;
      return yield* Effect.gen(function* () {
        const checks = yield* inspect;
        const confirmation = shutdownConfirmation(checks, action, options);
        if (confirmation === null) return true;
        return yield* dialog.request(
          `${confirmation.message}\n\n${confirmation.detail}`,
          confirmation.confirmLabel,
          confirmation.threadActivity,
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending = false;
          }),
        ),
      );
    }),
  });
});
export const layer = Layer.effect(DesktopShutdownGuard, make);
