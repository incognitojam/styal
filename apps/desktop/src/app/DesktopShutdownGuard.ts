import { HostActivity } from "@t3tools/contracts";
import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";

export type ShutdownAction = "quit" | "restart";
export type ActivityCheck = HostActivity | null;

export function shutdownConfirmationDetail(checks: ReadonlyArray<ActivityCheck>): string | null {
  let active = 0;
  let waiting = 0;
  let terminals = 0;
  let unknown = checks.length === 0;
  for (const check of checks) {
    if (check === null) {
      unknown = true;
      continue;
    }
    active += check.activeSessions;
    waiting += check.waitingSessions;
    terminals += check.terminalsRequiringConfirmation;
  }
  const lines: string[] = [];
  if (active) lines.push(`${active} agent session${active === 1 ? " is" : "s are"} working.`);
  if (waiting)
    lines.push(
      `${waiting} agent session${waiting === 1 ? " is" : "s are"} waiting for input or approval.`,
    );
  if (terminals)
    lines.push(
      `${terminals} terminal session${terminals === 1 ? " has" : "s have"} running work or could not be checked.`,
    );
  if (unknown) lines.push("Activity could not be checked for every local environment.");
  if (!lines.length) return null;
  return [
    ...lines,
    "",
    "Continuing stops the environments hosted by this app, including work started from other devices.",
  ].join("\n");
}

export class DesktopShutdownGuard extends Context.Service<
  DesktopShutdownGuard,
  {
    readonly confirm: (action: ShutdownAction) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/app/DesktopShutdownGuard") {}

export const make = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const http = yield* HttpClient.HttpClient;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const tokens = new Map<string, { credential: string; bearer: string; expiresAt: number }>();
  let pending = false;
  return DesktopShutdownGuard.of({
    confirm: (action) =>
      Effect.gen(function* () {
        if (pending) return false;
        pending = true;
        return yield* Effect.gen(function* () {
          const instances = yield* pool.list;
          const checks = yield* Effect.forEach(
            instances,
            (instance) =>
              Effect.gen(function* () {
                const snapshot = yield* instance.snapshot;
                if (!snapshot.desiredRunning && Option.isNone(snapshot.activePid)) {
                  return {
                    activeSessions: 0,
                    waitingSessions: 0,
                    terminalsRequiringConfirmation: 0,
                  };
                }
                const option = yield* instance.currentConfig;
                if (Option.isNone(option)) return null;
                const config = option.value;
                const credential = config.bootstrap.desktopBootstrapToken;
                if (!credential) return null;
                const key = config.httpBaseUrl.href;
                let token = tokens.get(key);
                const now = yield* Clock.currentTimeMillis;
                if (!token || token.credential !== credential || token.expiresAt <= now) {
                  const session = yield* bootstrapRemoteBearerSession({
                    httpBaseUrl: key,
                    credential,
                    clientMetadata: { label: "Desktop shutdown check", deviceType: "desktop" },
                  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
                  token = {
                    credential,
                    bearer: session.access_token,
                    expiresAt: now + Math.max(0, session.expires_in - 5) * 1000,
                  };
                  tokens.set(key, token);
                }
                const response = yield* http.execute(
                  HttpClientRequest.get(new URL("/api/environment/activity", key).href).pipe(
                    HttpClientRequest.bearerToken(token.bearer),
                  ),
                );
                if (response.status !== 200) {
                  tokens.delete(key);
                  return null;
                }
                return yield* response.json.pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(HostActivity)),
                );
              }).pipe(
                Effect.timeout("3 seconds"),
                Effect.catchCause(() => Effect.succeed(null)),
              ),
            { concurrency: "unbounded" },
          );
          const detail = shutdownConfirmationDetail(checks);
          if (detail === null) return true;
          const verb = action === "quit" ? "Quit" : "Restart";
          return yield* dialog
            .showMessageBox({
              type: "warning",
              title: `${verb} styal?`,
              message: `${verb} while work may be interrupted?`,
              detail,
              buttons: ["Cancel", `${verb} anyway`],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            })
            .pipe(
              Effect.map((result) => result.response === 1),
              Effect.catchCause(() => Effect.succeed(false)),
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
