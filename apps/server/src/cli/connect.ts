import {
  AuthRelayWriteScope,
  EnvironmentHttpApi,
  type RelayClientInstallProgressEvent,
  type RelayClientInstallProgressStage,
} from "@t3tools/contracts";
import { RelayOkResponse, RelaySignInCode, RelaySignInEmail } from "@t3tools/contracts/relay";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as RelayClient from "@t3tools/shared/relayClient";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BootService from "../cloud/bootService.ts";
import * as CliState from "../cloud/CliState.ts";
import * as CliSession from "../cloud/CliSession.ts";
import { filterRelayResponse } from "../cloud/relayResponse.ts";
import {
  CLOUD_LINKED_USER_ID,
  isAgentActivityPublishingEnabledValue,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import { relayUrlConfig } from "../cloud/publicConfig.ts";
import * as RelayTracing from "../cloud/relayTracing.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { resolveCliCommand } from "./invocation.ts";
import { offerServiceDuringOnboarding, recoverServiceOnboardingOffer } from "./service.ts";
import * as CliService from "./service.ts";

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const emailFlag = Flag.String("email").pipe(
  Flag.withDescription("Email address to sign in with. You are asked for it when omitted."),
  Flag.optional,
);

// Kept for one release so scripts that pass it keep working; sign-in now
// happens in the terminal everywhere.
const headlessFlag = Flag.Boolean("headless").pipe(Flag.withDefault(false), Flag.withHidden);

export class CloudCliInteractiveTerminalRequiredError extends Schema.TaggedError<CloudCliInteractiveTerminalRequiredError>()(
  "CloudCliInteractiveTerminalRequiredError",
  {},
) {
  override get message(): string {
    return "Signing in to styal Link asks for a code from your email. Run `styal link login` in an interactive terminal.";
  }
}

export class CloudCliInvalidEmailError extends Schema.TaggedError<CloudCliInvalidEmailError>()(
  "CloudCliInvalidEmailError",
  { email: Schema.String },
) {
  override get message(): string {
    return `${this.email} is not an email address.`;
  }
}

const isRelaySignInEmail = Schema.is(RelaySignInEmail);
const isRelaySignInCode = Schema.is(RelaySignInCode);

function normalizeSignInCode(value: string): string {
  return value.replace(/[\s-]/g, "");
}

const promptSignInEmail = Prompt.run(
  Prompt.String({
    message: "Email",
    validate: (value) =>
      isRelaySignInEmail(value.trim())
        ? Effect.succeed(value.trim())
        : Effect.fail("Enter an email address."),
  }),
);

const promptSignInCode = Prompt.run(
  Prompt.String({
    message: 'Code (or "r" to resend)',
    validate: (value) => {
      const trimmed = value.trim();
      if (trimmed.toLowerCase() === "r") return Effect.succeed("r");
      const code = normalizeSignInCode(trimmed);
      return isRelaySignInCode(code)
        ? Effect.succeed(code)
        : Effect.fail('Enter the 8-digit code, or "r" to send a new one.');
    },
  }),
);

function codeLifetime(expiresAt: string, nowEpochMs: number): string {
  const minutes = Math.round((Date.parse(expiresAt) - nowEpochMs) / 60_000);
  return Number.isFinite(minutes) && minutes >= 1
    ? ` It expires in ${minutes} minute${minutes === 1 ? "" : "s"}.`
    : "";
}

/**
 * Emails a sign-in code and reads it back from the terminal. A wrong code is
 * asked for again; "r" sends a new code once the relay's resend delay passed.
 */
export const runEmailSignIn = Effect.fn("cloud.cli.run_email_sign_in")(function* <E, R>(input: {
  readonly session: CliSession.CloudCliSession["Service"];
  readonly email: string;
  readonly promptCode: Effect.Effect<string, E, R>;
}) {
  const { session, email } = input;
  let resendAvailableAtEpochMs = 0;
  const sendCode = Effect.fn("cloud.cli.send_sign_in_code")(function* (resend: boolean) {
    const started = yield* session.startEmailSignIn(email);
    const now = yield* Clock.currentTimeMillis;
    resendAvailableAtEpochMs = now + started.resendAfterSeconds * 1_000;
    yield* Console.log(
      `${resend ? "Sent a new 8-digit code" : "Sent an 8-digit code"} to ${email}.${codeLifetime(started.expiresAt, now)}`,
    );
  });
  yield* sendCode(false);
  while (true) {
    const answer = yield* input.promptCode;
    if (answer === "r") {
      const now = yield* Clock.currentTimeMillis;
      if (now < resendAvailableAtEpochMs) {
        const seconds = Math.ceil((resendAvailableAtEpochMs - now) / 1_000);
        yield* Console.log(`You can request a new code in ${seconds} seconds.`);
        continue;
      }
      yield* sendCode(true).pipe(
        Effect.catchTags({
          CloudCliSignInRateLimitedError: (error) => Console.log(error.message),
          CloudCliEmailSignInUnavailableError: (error) => Console.log(error.message),
          CloudCliRelayUnavailableError: (error) => Console.log(error.message),
        }),
      );
      continue;
    }
    const verified = yield* session.verifyEmailSignIn({ email, code: answer }).pipe(
      Effect.asSome,
      Effect.catchTags({
        CloudCliSignInCodeError: (error) =>
          Console.log(
            error.reason === "incorrect"
              ? `${error.message} Try again, or enter "r" to send a new code.`
              : `${error.message} Enter "r" to send a new code.`,
          ).pipe(Effect.as(Option.none())),
        CloudCliSignInRateLimitedError: (error) =>
          Console.log(error.message).pipe(Effect.as(Option.none())),
        CloudCliRelayUnavailableError: (error) =>
          Console.log(error.message).pipe(Effect.as(Option.none())),
      }),
    );
    if (Option.isSome(verified)) {
      return verified.value;
    }
  }
});

/** Returns the signed-in account, signing in first when no session is stored. */
export const authorizeCli = Effect.fn("cloud.cli.authorize")(function* (options: {
  readonly email: Option.Option<string>;
}) {
  const session = yield* CliSession.CloudCliSession;
  const existing = yield* session.currentIdentity.pipe(
    Effect.catchIf(
      (error) => !CliSession.canRetryCredentialRecovery(error),
      (error) => Console.log(error.message).pipe(Effect.as(Option.none())),
    ),
  );
  if (Option.isSome(existing)) {
    if (
      Option.isSome(options.email) &&
      options.email.value.trim().toLowerCase() !== existing.value.email?.toLowerCase()
    ) {
      yield* Console.warn(
        "The requested email does not match the stored styal Link account. Run `styal link logout`, then sign in with the other email.",
      );
    }
    return existing.value;
  }
  if (!process.stdin.isTTY) {
    return yield* new CloudCliInteractiveTerminalRequiredError();
  }
  const email = Option.isSome(options.email)
    ? options.email.value.trim()
    : yield* promptSignInEmail;
  if (!isRelaySignInEmail(email)) {
    return yield* new CloudCliInvalidEmailError({ email });
  }
  return yield* runEmailSignIn({ session, email, promptCode: promptSignInCode });
});

function bytesToString(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

interface CloudCliStatus {
  readonly desired: boolean;
  readonly authenticated: boolean;
  readonly email: string | null;
  readonly linked: boolean;
  readonly cloudUserId: string | null;
  readonly relayUrl: string | null;
  readonly publishAgentActivity: boolean;
  readonly relayClient: RelayClient.RelayClientStatus;
}

function formatRelayClientStatus(executable: RelayClient.RelayClientStatus): ReadonlyArray<string> {
  switch (executable.status) {
    case "available": {
      const source =
        executable.source === "path"
          ? "PATH"
          : executable.source === "managed"
            ? "managed install"
            : "configured override";
      return [
        `  Relay client: available via ${source}`,
        `    Path: ${executable.executablePath}`,
        `    Version: ${executable.version}`,
      ];
    }
    case "missing":
      return ["  Relay client: not installed"];
    case "unsupported":
      return [
        `  Relay client: unsupported on ${executable.platform}-${executable.arch}`,
        `    Managed version: ${executable.version}`,
      ];
  }
}

function formatCloudStatus(status: CloudCliStatus, options?: { readonly json?: boolean }): string {
  if (options?.json) {
    return JSON.stringify(status, null, 2);
  }

  const provisioned = status.linked
    ? "provisioned"
    : status.desired && status.authenticated
      ? "pending server startup"
      : "not provisioned";
  const nextStep = !status.authenticated
    ? "Run `styal link` to sign in and enable styal Link."
    : !status.desired
      ? "Run `styal link` to enable styal Link."
      : !status.linked
        ? "Start styal to provision the environment link and launch its managed tunnel."
        : undefined;

  return [
    "styal Link",
    `  Exposure: ${status.desired ? "enabled" : "disabled"}`,
    `  Account: ${status.authenticated ? (status.email ?? "signed in") : "signed out"}`,
    `  Environment link: ${provisioned}`,
    `  Relay: ${status.relayUrl ?? "not provisioned"}`,
    `  Publish agent activity: ${status.publishAgentActivity ? "enabled" : "disabled"}`,
    ...formatRelayClientStatus(status.relayClient),
    "",
    "This is saved setup, not a live connection check. Check the background service with `styal service status`.",
    ...(nextStep ? ["", `Next: ${nextStep}`] : []),
  ].join("\n");
}

const CLOUD_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(5);

const confirmRelayClientInstall = (version: string) =>
  Prompt.run(
    Prompt.Confirm({
      message: `The relay client is required for styal Link. Download and install version ${version}?`,
      initial: false,
    }),
  );

function relayClientInstallProgressMessage(stage: RelayClientInstallProgressStage): string {
  switch (stage) {
    case "checking":
      return "Checking existing installation";
    case "waiting_for_lock":
      return "Waiting for installation lock";
    case "downloading":
      return "Downloading";
    case "verifying":
      return "Verifying download";
    case "installing":
      return "Installing";
    case "validating":
      return "Validating executable";
    case "activating":
      return "Activating installation";
  }
}

const reportRelayClientInstallProgress = (event: RelayClientInstallProgressEvent) =>
  event.type === "progress"
    ? Console.log(`Relay client: ${relayClientInstallProgressMessage(event.stage)}...`)
    : Effect.void;

export const acquireRelayClientForLink = Effect.fn("cloud.cli.acquire_relay_client_for_link")(
  function* <ConfirmError, ConfirmContext>(
    relayClient: RelayClient.RelayClient["Service"],
    confirmInstall: (version: string) => Effect.Effect<boolean, ConfirmError, ConfirmContext>,
    reportProgress: (event: RelayClientInstallProgressEvent) => Effect.Effect<void>,
  ) {
    const executable = yield* relayClient.resolve;
    if (executable.status === "available") {
      return Option.some(executable);
    }
    if (executable.status === "unsupported") {
      return Option.some(yield* relayClient.installWithProgress(reportProgress));
    }
    if (!(yield* confirmInstall(executable.version))) {
      return Option.none();
    }
    return Option.some(yield* relayClient.installWithProgress(reportProgress));
  },
);

const withCloudCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: [AuthRelayWriteScope],
      subject: "cloud-cli",
      label: "styal link cli",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

type LiveCloudActionResult =
  | { readonly status: "not-running" }
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly cause: Cause.Cause<unknown> };

const runLiveCloudUnlink = Effect.fn("cloud.cli.run_live_unlink")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) {
    return { status: "not-running" } satisfies LiveCloudActionResult;
  }

  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const result = yield* Effect.exit(
    withCloudCliSessionToken(environmentAuth, (token) =>
      HttpApiClient.make(EnvironmentHttpApi, {
        baseUrl: runtimeState.value.origin,
      }).pipe(
        Effect.flatMap((client) =>
          client.connect.unlink({ headers: { authorization: `Bearer ${token}` } }),
        ),
        Effect.timeout(CLOUD_CLI_LIVE_SERVER_TIMEOUT),
      ),
    ),
  );
  return Exit.isSuccess(result)
    ? ({ status: "succeeded" } satisfies LiveCloudActionResult)
    : ({ status: "failed", cause: result.cause } satisfies LiveCloudActionResult);
});

type RelayUnlinkResult =
  | { readonly status: "not-authenticated" }
  | { readonly status: "revoked" }
  | { readonly status: "not-linked" };

type CloudDisconnectOperation = "live-server-unlink" | "relay-environment-unlink";

const logCloudDisconnectFailure = (
  operation: CloudDisconnectOperation,
  clearAuthorization: boolean,
  cause: Cause.Cause<unknown>,
) =>
  Effect.logWarning("styal Link disconnect operation failed.").pipe(
    Effect.annotateLogs({
      operation,
      clearAuthorization,
      cause: Cause.pretty(cause),
    }),
  );

const unlinkRelayEnvironment = Effect.fn("cloud.cli.unlink_relay_environment")(function* () {
  const session = yield* CliSession.CloudCliSession;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* environment.getEnvironmentId;
  const relayUrl = yield* relayUrlConfig;
  const unlinkUrl = `${relayUrl}/v1/client/environment-links/${encodeURIComponent(environmentId)}`;
  const authorization = yield* session.authorize("DELETE", unlinkUrl);
  if (Option.isNone(authorization)) {
    return { status: "not-authenticated" } satisfies RelayUnlinkResult;
  }

  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.delete(unlinkUrl).pipe(
    HttpClientRequest.setHeaders({ ...authorization.value }),
    httpClient.execute,
    Effect.flatMap(filterRelayResponse),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayOkResponse)),
    withRelayClientTracing,
  );
  return response.ok
    ? ({ status: "revoked" } satisfies RelayUnlinkResult)
    : ({ status: "not-linked" } satisfies RelayUnlinkResult);
});

export const reportCloudDisconnectResults = Effect.fn("cloud.cli.report_disconnect_results")(
  function* (input: {
    readonly clearAuthorization: boolean;
    readonly liveResult: LiveCloudActionResult;
    readonly relayResult: Exit.Exit<RelayUnlinkResult, unknown>;
  }) {
    if (input.liveResult.status === "failed") {
      yield* logCloudDisconnectFailure(
        "live-server-unlink",
        input.clearAuthorization,
        input.liveResult.cause,
      );
      yield* Console.warn(
        "styal Link is disabled, but the running server could not stop its tunnel.\nRestart that server to stop the connector.",
      );
    } else {
      yield* Console.log("styal Link is disabled locally.");
    }

    if (Exit.isFailure(input.relayResult)) {
      yield* logCloudDisconnectFailure(
        "relay-environment-unlink",
        input.clearAuthorization,
        input.relayResult.cause,
      );
      yield* Console.warn(
        input.clearAuthorization
          ? "Could not revoke the relay-side environment record before signing out.\nThe stored CLI authorization was still removed locally."
          : "Could not revoke the relay-side environment record yet.\nRun `styal link unlink` again when the relay is reachable.",
      );
    } else if (input.relayResult.value.status === "revoked") {
      yield* Console.log("Revoked the relay-side environment record.");
    }
  },
);

const disconnectCloud = Effect.fn("cloud.cli.disconnect")(function* (options: {
  readonly clearAuthorization: boolean;
}) {
  yield* CliState.setCliDesiredCloudLink(false);
  const liveResult = yield* runLiveCloudUnlink();
  const relayResult = yield* Effect.exit(unlinkRelayEnvironment());
  yield* CliState.clearPersistedCloudLink;

  const signOut = options.clearAuthorization
    ? Option.some(yield* (yield* CliSession.CloudCliSession).signOut)
    : Option.none<CliSession.CloudCliSignOutResult>();

  yield* reportCloudDisconnectResults({
    clearAuthorization: options.clearAuthorization,
    liveResult,
    relayResult,
  });

  if (Option.isSome(signOut)) {
    if (signOut.value === "revoke-failed") {
      yield* Console.warn(
        "Could not end the styal Link session at the relay. It was removed from this machine; remove it from your signed-in devices when the relay is reachable.",
      );
    }
    yield* Console.log(
      "Signed out of styal Link.\nThe background service is managed separately with `styal service`.",
    );
  }
});

const runCloudCommand = Effect.fn("cloud.cli.run_cloud_command")(function* <A, E>(
  flags: { readonly baseDir: Option.Option<string> },
  run: Effect.Effect<
    A,
    E,
    | ServerSecretStore.ServerSecretStore
    | CliSession.CloudCliSession
    | RelayClient.RelayClient
    | EnvironmentAuth.EnvironmentAuth
    | BootService.BootService
    | Crypto.Crypto
    | FileSystem.FileSystem
    | HttpClient.HttpClient
    | Prompt.Environment
    | ServerConfig.ServerConfig
    | ServerEnvironment.ServerEnvironmentIdentity
  >,
  options?: {
    readonly quietLogs?: boolean;
  },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
  const layerRuntime = Layer.mergeAll(
    ServerSecretStore.layer,
    CliSession.layer.pipe(Layer.provide(ServerSecretStore.layer)),
    RelayClient.layerCloudflared({ baseDir: config.baseDir }),
    EnvironmentAuth.layerRuntime,
    CliService.layer(config),
    RelayTracing.layerHeadlessRelayClient,
  ).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
  );
  return yield* run.pipe(Effect.provide(layerRuntime));
});

const connectedAs = (identity: CliSession.CloudCliIdentity): string =>
  identity.email ? ` as ${identity.email}` : "";

function formatRelayClientReady(version: string): string {
  return `✓ Relay client ready · cloudflared ${version}`;
}

const linkEnvironmentForConnect = Effect.fn("cloud.cli.link_environment")(function* (options: {
  readonly email: Option.Option<string>;
  readonly publishOnly?: boolean;
}) {
  const publishOnly = options.publishOnly ?? false;
  if (!publishOnly) {
    const relayClient = yield* RelayClient.RelayClient;
    const installed = yield* acquireRelayClientForLink(
      relayClient,
      confirmRelayClientInstall,
      reportRelayClientInstallProgress,
    );
    if (Option.isNone(installed)) {
      yield* Console.log("styal Link setup cancelled. The relay client was not installed.");
      return null;
    }
    yield* Console.log(formatRelayClientReady(installed.value.version));
  }

  const identity = yield* authorizeCli(options);
  yield* CliState.setCliDesiredCloudLink(true, publishOnly ? "publish_only" : "managed");
  if (publishOnly) {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, stringToBytes("true"));
  }
  return { identity } as const;
});

const connectLoginCommand = Command.make("login", {
  ...projectLocationFlags,
  email: emailFlag,
  headless: headlessFlag,
}).pipe(
  Command.withDescription("Sign in to styal Link without enabling remote access."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        yield* Console.log("styal Link\n");
        const identity = yield* authorizeCli(flags);
        yield* Console.log(`✓ Signed in${connectedAs(identity)}`);
      }),
    ),
  ),
);

const connectLinkCommand = Command.make("link", {
  ...projectLocationFlags,
  email: emailFlag,
  headless: headlessFlag,
  publishOnly: Flag.Boolean("publish-only").pipe(
    Flag.withDescription(
      "Link to publish agent activity only — no managed tunnel. Reach this environment out of band (e.g. Tailscale).",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Authorize this environment for styal Link on next start."),
  Command.unlisted,
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        yield* Console.log("styal Link\n");
        const linked = yield* linkEnvironmentForConnect(flags);
        if (linked) {
          const serveCommand = yield* resolveCliCommand("serve");
          yield* Console.log(
            flags.publishOnly
              ? `✓ Authorized${connectedAs(linked.identity)}\n\nNext\n  Start styal to publish agent activity (no managed tunnel).`
              : `✓ Authorized${connectedAs(linked.identity)}\n\nNext\n  Start the server with \`${serveCommand}\` to make this machine reachable.`,
          );
        }
      }),
    ),
  ),
);

const connectStatusCommand = Command.make("status", {
  ...projectLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show persisted styal Link and relay client state."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const relayClient = yield* RelayClient.RelayClient;
        const session = yield* CliSession.CloudCliSession;
        const [
          desired,
          authenticated,
          identity,
          cloudUserId,
          relayUrl,
          publishAgentActivity,
          executable,
        ] = yield* Effect.all(
          [
            CliState.readCliDesiredCloudLink,
            session.hasCredential,
            session.storedIdentity,
            secrets.get(CLOUD_LINKED_USER_ID),
            secrets.get(RELAY_URL_SECRET),
            secrets.get(PUBLISH_AGENT_ACTIVITY_SECRET),
            relayClient.resolve,
          ],
          { concurrency: "unbounded" },
        );
        const status: CloudCliStatus = {
          desired,
          authenticated,
          email: Option.isSome(identity) ? identity.value.email : null,
          linked: Option.isSome(cloudUserId),
          cloudUserId: Option.isSome(cloudUserId) ? bytesToString(cloudUserId.value) : null,
          relayUrl: Option.isSome(relayUrl) ? bytesToString(relayUrl.value) : null,
          publishAgentActivity: isAgentActivityPublishingEnabledValue(
            Option.isSome(publishAgentActivity) ? bytesToString(publishAgentActivity.value) : null,
          ),
          relayClient: executable,
        };
        yield* Console.log(formatCloudStatus(status, { json: flags.json }));
      }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const connectPublishCommand = Command.make("publish", {
  ...projectLocationFlags,
  disable: Flag.Boolean("disable").pipe(
    Flag.withDescription("Stop publishing agent activity to your mobile clients."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Toggle publishing agent activity (push notifications and Live Activities) to your mobile clients.",
  ),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const session = yield* CliSession.CloudCliSession;
        const enabled = !flags.disable;
        yield* secrets.set(
          PUBLISH_AGENT_ACTIVITY_SECRET,
          stringToBytes(enabled ? "true" : "false"),
        );
        if (!enabled) {
          // If enabling scheduled a publish-only link that hasn't been
          // provisioned yet, disabling must cancel it too — otherwise the next
          // start still links an environment whose only purpose was publishing.
          // A pending managed link is left alone; it exists for the tunnel.
          const linkedNow = Option.isSome(yield* secrets.get(CLOUD_LINKED_USER_ID));
          if (!linkedNow && (yield* CliState.readCliDesiredLinkMode) === "publish_only") {
            yield* CliState.setCliDesiredCloudLink(false);
            yield* Console.log("Cancelled the pending publish-only styal Link.");
          }
          yield* Console.log("Publishing agent activity disabled.");
          return;
        }

        yield* Console.log("Publishing agent activity enabled.");
        const linked = Option.isSome(yield* secrets.get(CLOUD_LINKED_USER_ID));
        if (linked) {
          return;
        }

        // Publishing needs the relay to know this environment belongs to you.
        // Establish a tunnel-free publish-only link automatically so signing in
        // is all it takes — the mobile client can still reach the environment
        // out of band without styal Link.
        if (!(yield* session.hasCredential)) {
          yield* Console.log(
            "Run `styal link login` first so this environment can be authorized to publish.",
          );
          return;
        }
        // A link may already be desired (e.g. `styal link` before the
        // server's first start). Never downgrade it: a desired managed link
        // also covers publishing, so only request a publish-only link when no
        // link is pending at all.
        if (yield* CliState.readCliDesiredCloudLink) {
          yield* Console.log(
            "A styal Link is already pending. Start styal to finish provisioning it; publishing starts once it links.",
          );
          return;
        }
        yield* CliState.setCliDesiredCloudLink(true, "publish_only");
        yield* Console.log(
          "Restart styal to finish authorizing this environment to publish (no managed tunnel is created).",
        );
      }),
    ),
  ),
);

const connectUnlinkCommand = Command.make("unlink", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription("Disable styal Link while retaining the stored authorization."),
  Command.withHandler((flags) =>
    runCloudCommand(flags, disconnectCloud({ clearAuthorization: false })),
  ),
);

const connectLogoutCommand = Command.make("logout", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription("Disable styal Link and clear the stored CLI authorization."),
  Command.withHandler((flags) =>
    runCloudCommand(flags, disconnectCloud({ clearAuthorization: true })),
  ),
);

const linkCommandFlags = {
  ...projectLocationFlags,
  email: emailFlag,
  headless: headlessFlag,
} as const;

const runLinkOnboarding = (flags: {
  readonly baseDir: Option.Option<string>;
  readonly email: Option.Option<string>;
  readonly headless: boolean;
}) =>
  runCloudCommand(
    flags,
    Effect.gen(function* () {
      yield* Console.log("styal Link\n");
      const linked = yield* linkEnvironmentForConnect(flags);
      if (!linked) {
        return;
      }
      // Show which account was linked so an unexpected identity is visible
      // before the machine is brought online.
      yield* Console.log(`✓ Authorized${connectedAs(linked.identity)}`);

      // Authorization is stored. If service setup fails, preserve it and
      // show how to run the server manually.
      const background = yield* recoverServiceOnboardingOffer(offerServiceDuringOnboarding);
      if (background) {
        const platform = yield* HostProcess.Platform;
        yield* Console.log(
          platform === "darwin"
            ? "\n✓ Background service ready\n\nstyal is set to run while you are logged in to this Mac. The server establishes the styal Link connection on startup."
            : "\n✓ Background service ready\n\nstyal is set to keep running after you log out. The server establishes the styal Link connection on startup.",
        );
        return;
      }
      const serveCommand = yield* resolveCliCommand("serve");
      yield* Console.log(
        `\nNext\n  Start the server with \`${serveCommand}\` to make this machine reachable.`,
      );
    }),
  );

const linkSubcommands = [
  connectLoginCommand,
  connectLinkCommand,
  connectPublishCommand,
  connectStatusCommand,
  connectUnlinkCommand,
  connectLogoutCommand,
] as const;

export const linkCommand = Command.make("link", linkCommandFlags).pipe(
  Command.withDescription("Set up styal Link for this machine."),
  Command.withHandler(runLinkOnboarding),
  Command.withSubcommands(linkSubcommands),
);

export const connectCompatibilityCommand = Command.make("connect", linkCommandFlags).pipe(
  Command.withDescription("Set up styal Link for this machine."),
  Command.withHandler(runLinkOnboarding),
  Command.withSubcommands(linkSubcommands),
  Command.unlisted,
);
