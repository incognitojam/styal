import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle/Postgres";
import * as Config from "effect/Config";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Etag from "effect/http/Etag";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiScalar from "effect/http-api/HttpApiScalar";

import { RelayApi } from "@t3tools/contracts/relay";

import {
  RELAY_HTTP_ROUTER_CONFIG,
  traceRelayHttpRequestWith,
  withoutCapturedParentSpan,
} from "./http/Api.ts";
import * as RelayHttpApi from "./http/Api.ts";
import { ManagedEndpointZone, RelayApiZone, RelayDeploymentConfig } from "./zone.ts";
import * as Observability from "./observability.ts";
import * as AccountAuth from "./auth/AccountAuth.ts";
import * as AgentActivityPublisher from "./agentActivity/AgentActivityPublisher.ts";
import * as RelayRuntime from "./Runtime.ts";
import { pruneExpiredState } from "./pruneExpiredState.ts";
import * as EmailSender from "./auth/EmailSender.ts";
import * as RelayDb from "./db.ts";
import {
  RelayApnsDeliveryDeadLetterQueue,
  RelayApnsDeliveryQueue,
  RelayFcmDeliveryQueue,
  RelayFcmDeliveryDeadLetterQueue,
  queueSendOptions,
} from "./queues.ts";
import * as FcmDeliveryQueueSender from "./agentActivity/FcmDeliveryQueueSender.ts";
import * as FcmDeliveryQueueConsumer from "./agentActivity/FcmDeliveryQueueConsumer.ts";
import * as RelayConfiguration from "./Config.ts";
import * as ApnsClient from "./agentActivity/ApnsClient.ts";
import * as ApnsProviderTokens from "./agentActivity/ApnsProviderTokens.ts";
import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsDeliveries from "./agentActivity/ApnsDeliveries.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProvider.ts";
import * as ManagedEndpointReaper from "./environments/ManagedEndpointReaper.ts";
import * as HookForwarder from "./hooks/HookForwarder.ts";
import * as HookInbox from "./hooks/HookInbox.ts";
import * as HookInboxObject from "./hooks/HookInboxObject.ts";
import * as CloudflareApiPause from "./environments/CloudflareApiPause.ts";

const layerWebcrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

const layerHttpPlatformNotSupported = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: Effect.fn("HttpPlatform.fileResponse")(function () {
    return Effect.die("Relay API does not serve filesystem responses");
  }),
  fileWebResponse: Effect.fn("HttpPlatform.fileWebResponse")(function () {
    return Effect.die("Relay API does not serve file responses");
  }),
});

const CloudMintKeyPair = Alchemy.KeyPair("CloudMintKeyPair");
const ApnsDeliveryJobSigningSecret = Alchemy.makeRandom("ApnsDeliveryJobSigningSecret", {
  bytes: 32,
});
const SignInCodeSecret = Alchemy.makeRandom("SignInCodeSecret", { bytes: 32 });

export class Api extends Cloudflare.Worker<Api, {}>()("Api") {}

export const layer = Api.make(
  RelayDeploymentConfig.pipe(
    Effect.map(({ relayPublicDomain }) => ({
      main: import.meta.filename,
      compatibility: {
        date: "2026-05-22",
        flags: ["nodejs_compat"],
      },
      // Requests run several Postgres queries in sequence. At the user's edge
      // each one paid the round trip to the database (~300 ms from JNB); next
      // to PlanetScale `us-west` the request pays that distance once.
      placement: { region: "aws:us-west-2" },
      domain: relayPublicDomain,
    })),
    Effect.orDie,
  ),
  Effect.gen(function* () {
    const { relayPublicOrigin, stage } = yield* RelayDeploymentConfig;
    const apnsDeliveryQueue = yield* RelayApnsDeliveryQueue;
    const apnsDeliveryDeadLetterQueue = yield* RelayApnsDeliveryDeadLetterQueue;
    const fcmDeliveryQueue = yield* RelayFcmDeliveryQueue;
    const fcmDeliveryDeadLetterQueue = yield* RelayFcmDeliveryDeadLetterQueue;
    const cloudMintKeyPair = yield* CloudMintKeyPair;
    const relayApiZone = yield* RelayApiZone;
    const managedEndpointZone = yield* ManagedEndpointZone;
    const randomApnsDeliveryJobSigningSecret = yield* ApnsDeliveryJobSigningSecret;
    const randomSignInCodeSecret = yield* SignInCodeSecret;

    // APNs is optional as one all-or-nothing group: absent runs the relay
    // with push delivery disabled, a partial group fails resolution loudly.
    const apnsCredentials = yield* RelayConfiguration.apnsCredentialsConfig;
    if (apnsCredentials === null) {
      yield* Effect.logInfo("APNs is not configured; mobile push delivery is disabled.");
    }
    const fcmServiceAccount = Option.getOrUndefined(
      Option.filter(
        yield* Config.option(Config.Redacted("FCM_SERVICE_ACCOUNT")),
        (value) => Redacted.value(value).trim().length > 0,
      ),
    );
    const apnsDeliveryJobSigningSecret = yield* randomApnsDeliveryJobSigningSecret;
    const signInCodeSecret = yield* randomSignInCodeSecret;
    const apnsDeliveryQueueSender = yield* Cloudflare.Queues.WriteQueue(apnsDeliveryQueue);
    const fcmDeliveryQueueSender = yield* Cloudflare.Queues.WriteQueue(fcmDeliveryQueue);

    // Unset or empty turns off Clerk lookups: email sign-in then creates
    // relay-owned accounts and account deletion skips Clerk.
    const clerkSecretKey = yield* Config.Redacted("CLERK_SECRET_KEY").pipe(
      Config.withDefault(Redacted.make("")),
    );
    const clerkPublishableKey = yield* Config.String("CLERK_PUBLISHABLE_KEY");
    const clerkJwtAudience = yield* Config.String("CLERK_JWT_AUDIENCE");
    const t3ChatLinkSecret = Option.getOrUndefined(
      Option.filter(
        yield* Config.option(Config.Redacted("T3CHAT_LINK_SECRET")),
        (value) => Redacted.value(value).trim().length > 0,
      ),
    );
    const t3ChatBaseUrl = yield* Config.String("T3CHAT_URL").pipe(
      Config.withDefault("https://t3.chat"),
    );

    const cloudMintPrivateKey = yield* cloudMintKeyPair.privateKey;
    const cloudMintPublicKey = yield* cloudMintKeyPair.publicKey;
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(yield* RelayDb.RelayHyperdrive);
    // Named statements collide behind Hyperdrive transaction pooling (Effect-TS/effect#8320); use unnamed statements.
    const db = yield* Drizzle.Postgres(hyperdrive.connectionString, {
      client: { prepare: false },
    });

    const managedEndpointTunnelBinding = yield* Cloudflare.Tunnel.ReadWriteTunnel();
    // Keep Worker custom-domain reconciliation ordered after API zone provisioning.
    yield* yield* relayApiZone.zoneId;
    const managedEndpointDnsBinding = yield* Cloudflare.DNS.ReadWriteDns(managedEndpointZone);
    const managedEndpointZoneName = yield* managedEndpointZone.name;
    const managedEndpointCleanupMode = yield* RelayConfiguration.managedEndpointCleanupModeConfig;
    const legacyManagedEndpointCleanupMode =
      yield* RelayConfiguration.legacyManagedEndpointCleanupModeConfig;
    const legacyTunnelGraceMinutes = Option.getOrUndefined(
      yield* RelayConfiguration.legacyTunnelGraceMinutesConfig,
    );
    // Endpoint keys and their hashes differ by stage, including in shared accounts.
    const hookRateLimit = yield* Cloudflare.RateLimit("HOOK_RATE_LIMIT", {
      namespaceId: 1001,
      simple: {
        limit: HookForwarder.RELAY_HOOK_RATE_LIMIT.limit,
        period: HookForwarder.RELAY_HOOK_RATE_LIMIT.periodSeconds,
      },
    });
    const hookEndpointRateLimit = yield* Cloudflare.RateLimit("HOOK_ENDPOINT_RATE_LIMIT", {
      namespaceId: 1002,
      simple: {
        limit: HookForwarder.RELAY_HOOK_ENDPOINT_RATE_LIMIT.limit,
        period: HookForwarder.RELAY_HOOK_ENDPOINT_RATE_LIMIT.periodSeconds,
      },
    });
    const hookInboxes = yield* HookInboxObject.HookInboxObject;

    const emailSignIn = yield* RelayConfiguration.emailSignInConfig(stage);
    const signInEmail =
      emailSignIn.delivery.kind === "cloudflare"
        ? yield* Cloudflare.Email.Send(
            yield* Cloudflare.Email.SendEmail("SIGN_IN_EMAIL", {
              allowedSenderAddresses: [emailSignIn.delivery.fromAddress],
            }),
          )
        : undefined;
    if (emailSignIn.delivery.kind === "disabled") {
      yield* Effect.logInfo("Email sign-in is not configured; RELAY_EMAIL_FROM_ADDRESS is unset.");
    }
    // Per client IP. Namespace ids are account-wide and these keys do not
    // differ per stage on their own, so they carry the stage.
    const signInStartRateLimit = yield* Cloudflare.RateLimit("SIGN_IN_START_RATE_LIMIT", {
      namespaceId: 1003,
      simple: { limit: 10, period: 60 },
    });
    const signInVerifyRateLimit = yield* Cloudflare.RateLimit("SIGN_IN_VERIFY_RATE_LIMIT", {
      namespaceId: 1004,
      simple: { limit: 30, period: 60 },
    });

    const alchemyRuntimeContext: Alchemy.BaseRuntimeContext = yield* Cloudflare.Worker;

    const loadSettings = Effect.gen(function* () {
      return RelayConfiguration.RelayConfiguration.of({
        relayIssuer: relayPublicOrigin,
        ...(fcmServiceAccount ? { fcmServiceAccount } : {}),
        apns: apnsCredentials,
        apnsDeliveryJobSigningSecret: yield* apnsDeliveryJobSigningSecret,
        signInCodeSecret: yield* signInCodeSecret,
        ...(emailSignIn.testSignInCode ? { testSignInCode: emailSignIn.testSignInCode } : {}),
        clerkSecretKey,
        clerkPublishableKey,
        clerkJwtAudience,
        cloudMintPrivateKey: yield* cloudMintPrivateKey,
        cloudMintPublicKey: yield* cloudMintPublicKey,
        managedEndpointBaseDomain: yield* managedEndpointZoneName,
        managedEndpointNamespace: stage,
        managedEndpointCleanupMode,
        legacyManagedEndpointCleanupMode,
        ...(legacyTunnelGraceMinutes === undefined ? {} : { legacyTunnelGraceMinutes }),
        ...(t3ChatLinkSecret
          ? { t3Chat: { baseUrl: t3ChatBaseUrl, linkSecret: t3ChatLinkSecret } }
          : {}),
      });
    });

    const inboxCall =
      <A>(operation: HookInbox.HookInboxError["operation"], endpointKey: string) =>
      (effect: Effect.Effect<A, never, Alchemy.RuntimeContext>) =>
        effect.pipe(
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
          Effect.catchCause((cause) =>
            Effect.fail(
              new HookInbox.HookInboxError({
                operation,
                endpointKey,
                cause: Cause.squash(cause),
              }),
            ),
          ),
        );
    const layerHookInbox = Layer.succeed(HookInbox.HookInbox, {
      hold: Effect.fn("HookInbox.hold")(function ({ endpointKey, baseUrl, hook }) {
        return hookInboxes
          .getByName(endpointKey)
          .hold(hook, baseUrl)
          .pipe(inboxCall("hold", endpointKey));
      }),
      wake: Effect.fn("HookInbox.wake")(function ({ endpointKey, baseUrl }) {
        return hookInboxes
          .getByName(endpointKey)
          .wake(baseUrl)
          .pipe(inboxCall("wake", endpointKey));
      }),
      clear: Effect.fn("HookInbox.clear")(function ({ endpointKey }) {
        return hookInboxes.getByName(endpointKey).clear().pipe(inboxCall("clear", endpointKey));
      }),
    });

    const emailDelivery = emailSignIn.delivery;
    const layerEmailSender =
      signInEmail !== undefined && emailDelivery.kind === "cloudflare"
        ? Layer.succeed(
            EmailSender.EmailSender,
            EmailSender.make((email) =>
              signInEmail
                .send({
                  from: { email: emailDelivery.fromAddress, name: emailDelivery.fromName },
                  to: email.to,
                  subject: email.subject,
                  text: email.text,
                  html: email.html,
                })
                .pipe(
                  Effect.asVoid,
                  Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
                  Effect.mapError(
                    (error) =>
                      new EmailSender.EmailSendFailed({ detail: emailSendFailureDetail(error) }),
                  ),
                ),
            ),
          )
        : emailDelivery.kind === "log"
          ? EmailSender.layerLog
          : EmailSender.layerDisabled;

    // Fails open like the hook limiter; the per-address caps in Postgres still apply.
    const allowSignIn =
      (limiter: typeof signInStartRateLimit) =>
      (key: string): Effect.Effect<boolean> =>
        limiter.limit({ key: `${stage}:${key}` }).pipe(
          Effect.map((result) => result.success),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
          Effect.catch((error) =>
            Effect.logWarning("Sign-in rate limiter unavailable", { error: error.message }).pipe(
              Effect.andThen(
                Effect.annotateCurrentSpan({ "relay.auth.rate_limiter_failed_open": true }),
              ),
              Effect.as(true),
            ),
          ),
        );
    const layerSignInRateLimiter = Layer.succeed(AccountAuth.SignInRateLimiter, {
      allowStart: allowSignIn(signInStartRateLimit),
      allowVerify: allowSignIn(signInVerifyRateLimit),
    });

    const layerBindings = Layer.mergeAll(
      layerEmailSender,
      layerSignInRateLimiter,
      layerHookInbox,
      apnsCredentials === null
        ? ApnsClient.layerDisabled
        : ApnsClient.layer.pipe(Layer.provideMerge(ApnsProviderTokens.layer)),
      Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
        send: Effect.fn("ApnsDeliveryQueueSender.send")(
          function* (body, options) {
            return yield* apnsDeliveryQueueSender.send(body, queueSendOptions(options));
          },
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
        ),
      }),
      Layer.succeed(FcmDeliveryQueueSender.FcmDeliveryQueueSender, {
        send: Effect.fn("FcmDeliveryQueueSender.send")(
          function* (body, options) {
            return yield* fcmDeliveryQueueSender.send(body, queueSendOptions(options));
          },
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
        ),
      }),
      Layer.succeed(RelayDb.RelayDb, db),
      Layer.effect(RelayConfiguration.RelayConfiguration, loadSettings),
      layerWebcrypto,
    );
    // The Cloudflare clients share a database-backed rate-limit pause.
    const layerCloudflare = ManagedEndpointProvider.layerCloudflareClients(
      managedEndpointTunnelBinding,
      managedEndpointDnsBinding,
      alchemyRuntimeContext,
    ).pipe(Layer.provideMerge(CloudflareApiPause.layer), Layer.provide(layerBindings));
    const layerRuntime = RelayRuntime.layerServices.pipe(
      Layer.provideMerge(layerCloudflare),
      Layer.provideMerge(layerBindings),
    );

    // Fails open: a limiter outage must not drop webhooks.
    const allowWith =
      (limiter: typeof hookRateLimit) =>
      (key: string): Effect.Effect<boolean> =>
        limiter.limit({ key }).pipe(
          Effect.map((result) => result.success),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
          Effect.catch((error) =>
            Effect.logWarning("Rate limiter unavailable", { error: error.message }).pipe(
              Effect.andThen(
                Effect.annotateCurrentSpan({ "relay.hook.rate_limiter_failed_open": true }),
              ),
              Effect.as(true),
            ),
          ),
        );
    const layerHookRateLimiter = Layer.succeed(HookForwarder.HookRateLimiter, {
      allowHook: allowWith(hookRateLimit),
      allowEndpoint: allowWith(hookEndpointRateLimit),
    });

    const layerApp = RelayRuntime.makeAppLayer(layerRuntime).pipe(
      Layer.provide(layerHookRateLimiter),
    );

    yield* Cloudflare.Queues.consumeQueueMessages<unknown>(
      apnsDeliveryQueue,
      {
        batchSize: 10,
        maxRetries: 5,
        maxWaitTime: "5 seconds",
        retryDelay: "30 seconds",
        deadLetterQueue: apnsDeliveryDeadLetterQueue.queueName as unknown as string,
      },
      (stream) =>
        stream.pipe(
          Stream.withSpan("relay.apn_delivery_queue.process_batch"),
          Stream.runForEach((message) =>
            ApnsDeliveries.ApnsDeliveries.pipe(
              Effect.flatMap((deliveries) => deliveries.processSignedJob(message.body)),
              Effect.withSpan("relay.apn_delivery_queue.process_message"),
            ),
          ),
          Effect.provide(layerRuntime),
        ),
    );

    yield* Cloudflare.Queues.consumeQueueMessages<unknown>(
      fcmDeliveryQueue,
      {
        batchSize: 10,
        maxRetries: 5,
        maxWaitTime: "1 second",
        retryDelay: "30 seconds",
        deadLetterQueue: fcmDeliveryDeadLetterQueue.queueName as unknown as string,
      },
      (stream) =>
        stream.pipe(
          Stream.withSpan("relay.fcm_delivery_queue.process_batch"),
          Stream.runForEach(FcmDeliveryQueueConsumer.processMessage),
          Effect.provide(layerRuntime),
        ),
    );

    yield* Cloudflare.Workers.cron(
      managedEndpointCleanupMode === "off" ? "0 * * * *" : "*/5 * * * *",
      () =>
        Effect.all(
          [
            pruneExpiredState,
            ManagedEndpointReaper.ManagedEndpointReaper.pipe(
              Effect.flatMap((reaper) => reaper.sweep.pipe(Effect.timeout("2 minutes"))),
              Effect.tap((result) =>
                result.scanned > 0
                  ? Effect.logInfo("Finished managed tunnel cleanup", result)
                  : Effect.void,
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("Failed to clean up inactive managed tunnels", { cause }),
              ),
            ),
            AgentActivityPublisher.AgentActivityPublisher.pipe(
              Effect.flatMap((publisher) => publisher.endIdleLiveActivities),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("Failed to end idle Live Activities", { cause }),
              ),
            ),
          ],
          { concurrency: 3, discard: true },
        ).pipe(
          Effect.withSpan("relay.cron.prune_expired_state"),
          Observability.withSchemaErrorSpanAttributes,
          Effect.provide(layerRuntime),
        ),
    );

    const fetch = Layer.merge(
      Layer.mergeAll(
        HttpApiBuilder.layer(RelayApi, { openapiPath: "/openapi.json" }).pipe(
          Layer.provide(layerApp),
        ),
        HttpApiScalar.layer(RelayApi, { path: "/docs" }),
        RelayHttpApi.layerDocsRedirectRoute,
      ).pipe(
        Layer.provide([Etag.layerWeak, layerHttpPlatformNotSupported, RelayHttpApi.layerCors]),
      ),
      RelayHttpApi.layerNotFoundRoute,
    ).pipe(
      HttpRouter.toHttpEffect,
      Effect.provideService(HttpRouter.RouterConfig, RELAY_HTTP_ROUTER_CONFIG),
      withoutCapturedParentSpan,
      Effect.map((httpEffect) =>
        traceRelayHttpRequestWith(httpEffect, Layer.empty).pipe(
          Observability.withSchemaErrorSpanAttributes,
        ),
      ),
    );

    return { fetch };
  }).pipe(
    Effect.provide(
      Layer.empty.pipe(
        Layer.provideMerge(Cloudflare.Hyperdrive.ConnectBinding),
        Layer.provideMerge(Cloudflare.Workers.CronEventSourceLive),
        Layer.provideMerge(Cloudflare.Queues.WriteQueueBinding),
        Layer.provideMerge(Cloudflare.Queues.EventSourceLive),
        Layer.provideMerge(Cloudflare.Tunnel.ReadWriteTunnelBinding),
        Layer.provideMerge(Cloudflare.DNS.ReadWriteDnsHttp),
        Layer.provideMerge(Cloudflare.Workers.RateLimitBinding),
        Layer.provideMerge(Cloudflare.Email.SendBinding),
        Layer.provideMerge(HookInboxObject.layer),
        // Disable the duplicate runtime span; ours applies route/header/token redaction and rejects sender traceparent.
        Layer.provideMerge(
          Alchemy.Telemetry.layer(Layer.succeed(HttpMiddleware.TracerDisabledWhen)(() => true)),
        ),
      ),
    ),
  ),
);

/** Cloudflare's error code (such as E_DAILY_LIMIT_EXCEEDED) without the message, which can name the recipient. */
function emailSendFailureDetail(error: { readonly message: string; readonly cause?: unknown }) {
  const text = `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`;
  return /\bE_[A-Z_]+\b/.exec(text)?.[0] ?? "send_failed";
}

export default layer;
