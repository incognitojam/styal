import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { SecretStoreLockError, withSecretStoreLock } from "../auth/SecretStoreLock.ts";
import * as CliSession from "./CliSession.ts";

const RELAY_URL = "https://relay.example.test";
const CLERK_TOKEN_URL = "https://clerk.example.test/oauth/token";

// pk_test_<base64 of "clerk.example.test$">
const TEST_ENV = {
  T3CODE_RELAY_URL: RELAY_URL,
  T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_client_test",
};

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

type Reply = { readonly status: number; readonly body: unknown } | "network-error";

interface FakeRelay {
  beforeReply?: (request: RecordedRequest) => Effect.Effect<void>;
  stallBody?: boolean;
  readonly requests: Array<RecordedRequest>;
  /** Replies by URL; a list is consumed in order and its last entry repeats. */
  readonly replies: Map<string, Array<Reply>>;
  /** Thumbprints of the proof keys that signed each relay request. */
  readonly proofThumbprints: Array<string>;
}

const relayError = (tag: string, fields: Record<string, unknown>) => ({
  _tag: tag,
  traceId: "trace-1",
  ...fields,
});

const sessionResponse = (accessToken: string) => ({
  access_token: accessToken,
  token_type: "DPoP",
  expires_in: 1_800,
  scope: "account",
  user: { id: "user_1", email: "person@example.test" },
  refresh_token: "styal_rt_session1_secret",
  session_id: "session1",
});

const tokenResponse = (accessToken: string) => ({
  access_token: accessToken,
  token_type: "DPoP",
  expires_in: 1_800,
  scope: "account",
  user: { id: "user_1", email: "person@example.test" },
});

function makeFakeRelay(replies: Record<string, ReadonlyArray<Reply>> = {}): FakeRelay {
  return {
    requests: [],
    proofThumbprints: [],
    replies: new Map(
      Object.entries({
        [`${RELAY_URL}/v1/auth/email/start`]: [
          { status: 200, body: { expiresAt: "1970-01-01T00:10:00.000Z", resendAfterSeconds: 30 } },
        ],
        [`${RELAY_URL}/v1/auth/email/verify`]: [{ status: 200, body: sessionResponse("at-1") }],
        [`${RELAY_URL}/v1/auth/sign-out`]: [{ status: 200, body: { ok: true } }],
        ...replies,
      }).map(([url, list]) => [url, [...list]] as const),
    ),
  };
}

const layerFakeRelay = (relay: FakeRelay) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        relay.requests.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body,
        });
        if (relay.beforeReply) yield* relay.beforeReply(relay.requests.at(-1)!);
        if (request.url.startsWith(RELAY_URL)) {
          const now = yield* Clock.currentTimeMillis;
          const verified = verifyDpopProof({
            proof: request.headers.dpop,
            method: request.method,
            url: request.url,
            nowEpochSeconds: Math.floor(now / 1_000),
          });
          assert.isTrue(verified.ok, `DPoP proof for ${request.url}`);
          if (verified.ok) relay.proofThumbprints.push(verified.thumbprint);
        }
        const list = relay.replies.get(request.url) ?? [];
        const reply = (list.length > 1 ? list.shift() : list[0]) ?? { status: 404, body: {} };
        if (reply === "network-error") {
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          });
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(relay.stallBody ? new ReadableStream() : JSON.stringify(reply.body), {
            status: reply.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );

function makeMemorySecretStore(initial: Record<string, string> = {}) {
  const values = new Map<string, Uint8Array>(
    Object.entries(initial).map(([name, value]) => [name, new TextEncoder().encode(value)]),
  );
  const store: ServerSecretStore.ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) =>
      Effect.suspend(() =>
        values.has(name)
          ? Effect.fail(
              new ServerSecretStore.SecretStorePersistError({
                resource: name,
                cause: PlatformError.systemError({
                  _tag: "AlreadyExists",
                  module: "FileSystem",
                  method: "open",
                  pathOrDescriptor: name,
                }),
              }),
            )
          : Effect.sync(() => void values.set(name, value)),
      ),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  };
  const read = (name: string) => {
    const value = values.get(name);
    return value === undefined ? undefined : new TextDecoder().decode(value);
  };
  return { store, values, read };
}

const PersistedSessionJson = Schema.fromJsonString(
  Schema.Struct({
    refreshToken: Schema.String,
    userId: Schema.String,
    email: Schema.NullOr(Schema.String),
    relayUrl: Schema.String,
  }),
);
const decodePersistedSession = Schema.decodeUnknownSync(PersistedSessionJson);

const requestsTo = (relay: FakeRelay, url: string) =>
  relay.requests.filter((request) => request.url === url);

const withSession = <A, E, R>(
  relay: FakeRelay,
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  body: (session: CliSession.CloudCliSession["Service"]) => Effect.Effect<A, E, R>,
  env: Record<string, string> = TEST_ENV,
) =>
  Effect.gen(function* () {
    const session = yield* CliSession.make;
    return yield* body(session);
  }).pipe(
    Effect.provide(layerFakeRelay(relay)),
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

const signIn = (session: CliSession.CloudCliSession["Service"]) =>
  Effect.gen(function* () {
    yield* session.startEmailSignIn("person@example.test");
    return yield* session.verifyEmailSignIn({ email: "person@example.test", code: "12345678" });
  });

const legacyCredential = (expiresAtEpochMs = 0, refreshToken = "clerk-rt-1") =>
  JSON.stringify({ accessToken: "clerk-at-1", refreshToken, expiresAtEpochMs });

it.layer(NodeServices.layer)("CliSession", (it) => {
  it.effect("concurrent first sign-ins use the same persisted proof key", () => {
    const relay = makeFakeRelay();
    const secrets = makeMemorySecretStore();
    return withSession(relay, secrets.store, (first) =>
      withSession(relay, secrets.store, (second) =>
        Effect.gen(function* () {
          yield* Effect.all(
            [
              first.startEmailSignIn("person@example.test"),
              second.startEmailSignIn("person@example.test"),
            ],
            { concurrency: "unbounded" },
          );
          yield* first.verifyEmailSignIn({ email: "person@example.test", code: "12345678" });
          assert.lengthOf(relay.proofThumbprints, 3);
          assert.equal(new Set(relay.proofThumbprints).size, 1);
        }),
      ),
    );
  });

  it.effect.each([
    "",
    '{"kty":"EC"',
    JSON.stringify({ kty: "EC", crv: "P-256", x: "a", y: "b", d: "c" }),
  ])("preserves an unreadable key (%j) and recovers after explicit logout", (key) => {
    const relay = makeFakeRelay();
    const secrets = makeMemorySecretStore({ [CliSession.CLOUD_CLI_DPOP_KEY_SECRET]: key });
    return withSession(relay, secrets.store, (session) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(session.startEmailSignIn("person@example.test"));
        assert.instanceOf(error, CliSession.CloudCliDpopKeyError);
        assert.include(error.message, "stop other styal processes");
        assert.include(error.message, "styal link logout");
        assert.include(error.message, "styal link login");
        assert.equal(secrets.read(CliSession.CLOUD_CLI_DPOP_KEY_SECRET), key);
        assert.lengthOf(relay.requests, 0);
        yield* session.signOut;
        assert.isUndefined(secrets.read(CliSession.CLOUD_CLI_DPOP_KEY_SECRET));
        const identity = yield* signIn(session);
        assert.equal(identity.email, "person@example.test");
        assert.isTrue(yield* session.hasCredential);
      }),
    );
  });

  it.effect.each([
    { status: 408, body: { error: "invalid_grant" } },
    { status: 429, body: { error: "invalid_grant" } },
    { status: 500, body: { error: "invalid_grant" } },
    { status: 400, body: { error: "invalid_client" } },
    { status: 403, body: {} },
    "network-error",
  ] as const)("retains legacy credentials on Clerk %j", (reply) => {
    const relay = makeFakeRelay({ [CLERK_TOKEN_URL]: [reply] });
    const encoded = legacyCredential();
    const secrets = makeMemorySecretStore({
      [CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET]: encoded,
    });
    return withSession(relay, secrets.store, (session) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(session.currentIdentity);
        if (reply !== "network-error" && (reply.status === 400 || reply.status === 403)) {
          assert.instanceOf(error, CliSession.CloudCliClerkRefreshRejectedError);
          assert.include(error.message, "Clerk refused");
          assert.notInclude(error.message, "relay refused");
        } else {
          assert.instanceOf(error, CliSession.CloudCliRelayUnavailableError);
        }
        assert.equal(secrets.read(CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET), encoded);
        assert.isUndefined(secrets.read(CliSession.CLOUD_RELAY_SESSION_SECRET));
      }),
    );
  });

  it.effect("retains an expired legacy grant when the legacy configuration is missing", () => {
    const relay = makeFakeRelay();
    const encoded = legacyCredential();
    const secrets = makeMemorySecretStore({ [CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET]: encoded });
    return withSession(
      relay,
      secrets.store,
      (session) =>
        Effect.gen(function* () {
          assert.instanceOf(
            yield* Effect.flip(session.currentIdentity),
            CliSession.CloudCliLegacyClerkConfigError,
          );
          assert.equal(secrets.read(CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET), encoded);
          assert.lengthOf(relay.requests, 0);
        }),
      { T3CODE_RELAY_URL: RELAY_URL },
    );
  });

  it.effect.each(["invalid_bearer", "invalid_session", "invalid_dpop"] as const)(
    "only deletes the rejected legacy grant for relay invalid_bearer (%s)",
    (reason) => {
      const relay = makeFakeRelay({
        [`${RELAY_URL}/v1/auth/clerk-exchange`]: [
          {
            status: 401,
            body: relayError("RelayAuthInvalidError", { code: "auth_invalid", reason }),
          },
        ],
      });
      const encoded = legacyCredential(3_600_000);
      const secrets = makeMemorySecretStore({
        [CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET]: encoded,
      });
      return withSession(relay, secrets.store, (session) =>
        Effect.gen(function* () {
          if (reason === "invalid_bearer") {
            assert.isTrue(Option.isNone(yield* session.currentIdentity));
            assert.isUndefined(secrets.read(CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET));
          } else {
            const error = yield* Effect.flip(session.currentIdentity);
            assert.instanceOf(error, CliSession.CloudCliRelayRejectedError);
            if (reason === "invalid_dpop") assert.include(error.message, "system clock");
            assert.equal(secrets.read(CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET), encoded);
          }
        }),
      );
    },
  );

  it.effect.each(["clerk", "relay"] as const)(
    "keeps a newer legacy grant when %s rejects the old version",
    (rejectedAt) => {
      const relay = makeFakeRelay({
        [CLERK_TOKEN_URL]: [{ status: 400, body: { error: "invalid_grant" } }],
        [`${RELAY_URL}/v1/auth/clerk-exchange`]: [
          {
            status: 401,
            body: relayError("RelayAuthInvalidError", {
              code: "auth_invalid",
              reason: "invalid_bearer",
            }),
          },
        ],
      });
      const secrets = makeMemorySecretStore({
        [CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET]: legacyCredential(
          rejectedAt === "clerk" ? 0 : 3_600_000,
        ),
      });
      const newer = legacyCredential(3_600_000, "newer-rotated-grant");
      relay.beforeReply = () =>
        secrets.store
          .set(CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET, new TextEncoder().encode(newer))
          .pipe(Effect.orDie);
      return withSession(relay, secrets.store, (session) =>
        Effect.gen(function* () {
          assert.isTrue(Option.isNone(yield* session.currentIdentity));
          assert.equal(secrets.read(CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET), newer);
        }),
      );
    },
  );

  it.effect("does not re-adopt a retained Clerk token after the relay session ends", () => {
    const relay = makeFakeRelay({
      [`${RELAY_URL}/v1/auth/clerk-exchange`]: [{ status: 200, body: sessionResponse("at-1") }],
      [`${RELAY_URL}/v1/auth/token`]: [
        {
          status: 401,
          body: relayError("RelayAuthInvalidError", {
            code: "auth_invalid",
            reason: "invalid_session",
          }),
        },
      ],
    });
    const encoded = legacyCredential(3_600_000);
    const secrets = makeMemorySecretStore({ [CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET]: encoded });
    return withSession(relay, secrets.store, (session) =>
      Effect.gen(function* () {
        assert.isTrue(yield* session.hasCredential);
        assert.isTrue(Option.isSome(yield* session.currentIdentity));
        assert.isTrue(yield* session.hasCredential);
        yield* TestClock.adjust("31 minutes");
        assert.isTrue(Option.isNone(yield* session.currentIdentity));
        assert.isFalse(yield* session.hasCredential);
        assert.isDefined(secrets.read(CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET));
        assert.isTrue(Option.isNone(yield* session.currentIdentity));
        // A new process sees the persisted marker as well.
        yield* withSession(relay, secrets.store, (next) =>
          Effect.gen(function* () {
            assert.isTrue(Option.isNone(yield* next.currentIdentity));
            assert.isFalse(yield* next.hasCredential);
            yield* next.signOut;
          }),
        );
        assert.lengthOf(requestsTo(relay, `${RELAY_URL}/v1/auth/clerk-exchange`), 1);
        assert.isUndefined(secrets.read(CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET));
      }),
    );
  });

  it.effect.each([
    "network-error",
    { status: 503, body: {} },
    {
      status: 500,
      body: relayError("RelayInternalError", {
        code: "internal_error",
        reason: "upstream_unavailable",
      }),
    },
  ] as const)(
    "startup returns while adoption is blocked and retries transient %j without tunnel work",
    (reply) =>
      Effect.scoped(
        Effect.gen(function* () {
          const failed = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const persisted = yield* Deferred.make<void>();
          const relay = makeFakeRelay({
            [`${RELAY_URL}/v1/auth/clerk-exchange`]: [
              reply,
              { status: 200, body: sessionResponse("at-1") },
            ],
          });
          relay.beforeReply = () =>
            Deferred.succeed(failed, undefined).pipe(Effect.andThen(Deferred.await(release)));
          const memory = makeMemorySecretStore({
            [CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET]: legacyCredential(3_600_000),
          });
          const secrets = {
            ...memory.store,
            set: (name: string, bytes: Uint8Array) =>
              memory.store
                .set(name, bytes)
                .pipe(
                  Effect.tap(() =>
                    name === "cloud-cli-clerk-adopted"
                      ? Deferred.succeed(persisted, undefined)
                      : Effect.void,
                  ),
                ),
          };
          yield* withSession(relay, secrets, (session) =>
            Effect.gen(function* () {
              yield* Layer.build(
                CliSession.layerStartupAdoption.pipe(
                  Layer.provide(Layer.succeed(CliSession.CloudCliSession, session)),
                ),
              );
              yield* Deferred.await(failed);
              assert.isUndefined(memory.read(CliSession.CLOUD_RELAY_SESSION_SECRET));
              assert.isDefined(memory.read(CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET));
              yield* Deferred.succeed(release, undefined);
              yield* TestClock.adjust("1 second");
              yield* Deferred.await(persisted);
              assert.lengthOf(requestsTo(relay, `${RELAY_URL}/v1/auth/clerk-exchange`), 2);
              assert.isDefined(memory.read(CliSession.CLOUD_RELAY_SESSION_SECRET));
            }),
          );
        }),
      ),
  );

  it.effect.each([
    "missing-clerk-config",
    "missing-relay-config",
    "unreadable-token",
    "unreadable-key",
    "relay-invalid-dpop",
    "relay-invalid-request",
    "clerk-invalid-client",
  ] as const)("startup logs once and stops after %s", (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const failed = yield* Deferred.make<void>();
        const warnings: Array<unknown> = [];
        const relay = makeFakeRelay({
          [CLERK_TOKEN_URL]: [{ status: 400, body: { error: "invalid_client" } }],
          [`${RELAY_URL}/v1/auth/clerk-exchange`]: [
            scenario === "relay-invalid-request"
              ? { status: 400, body: { error: "invalid_request" } }
              : {
                  status: 401,
                  body: relayError("RelayAuthInvalidError", {
                    code: "auth_invalid",
                    reason: "invalid_dpop",
                  }),
                },
          ],
        });
        const encoded =
          scenario === "unreadable-token"
            ? "not-json"
            : legacyCredential(
                scenario === "missing-clerk-config" || scenario === "clerk-invalid-client"
                  ? 0
                  : (yield* Clock.currentTimeMillis) + 3_600_000,
              );
        const secrets = makeMemorySecretStore({
          [CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET]: encoded,
          ...(scenario === "unreadable-key" ? { [CliSession.CLOUD_CLI_DPOP_KEY_SECRET]: "" } : {}),
        });
        let attempts = 0;
        yield* withSession(
          relay,
          secrets.store,
          (session) =>
            Effect.gen(function* () {
              yield* Layer.build(
                CliSession.layerStartupAdoption.pipe(
                  Layer.provide(
                    Layer.succeed(CliSession.CloudCliSession, {
                      ...session,
                      currentIdentity: Effect.suspend(() => {
                        attempts += 1;
                        return session.currentIdentity.pipe(
                          Effect.tapError(() => Deferred.succeed(failed, undefined)),
                        );
                      }),
                    }),
                  ),
                  Layer.provide(
                    Logger.layer([Logger.make(({ message }) => warnings.push(message))], {
                      mergeWithExisting: false,
                    }),
                  ),
                ),
              );
              yield* Deferred.await(failed);
              yield* TestClock.adjust("10 minutes");
              assert.equal(attempts, 1);
              assert.lengthOf(warnings, 1);
              assert.include(String(warnings[0]), "adoption stopped");
              assert.equal(secrets.read(CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET), encoded);
            }),
          scenario === "missing-clerk-config"
            ? { T3CODE_RELAY_URL: RELAY_URL }
            : scenario === "missing-relay-config"
              ? {}
              : TEST_ENV,
        );
      }),
    ),
  );

  it.effect.each(["clerk", "exchange", "verify", "sign-out"] as const)(
    "times out a stalled %s request after 15 seconds and releases the credential lease",
    (point) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "clerk-cli-timeout-" });
          const entered = yield* Deferred.make<void>();
          const relay = makeFakeRelay();
          const encoded = legacyCredential(
            point === "clerk" ? 0 : (yield* Clock.currentTimeMillis) + 3_600_000,
          );
          const memory = makeMemorySecretStore(
            point === "clerk" || point === "exchange"
              ? { [CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET]: encoded }
              : {},
          );
          yield* withSession(relay, { ...memory.store, directory }, (session) =>
            Effect.gen(function* () {
              if (point === "sign-out") yield* signIn(session);
              const url =
                point === "clerk"
                  ? CLERK_TOKEN_URL
                  : `${RELAY_URL}/v1/auth/${point === "exchange" ? "clerk-exchange" : point === "verify" ? "email/verify" : "sign-out"}`;
              relay.beforeReply = (request) =>
                request.url === url
                  ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.void;
              const task =
                point === "sign-out"
                  ? session.signOut
                  : point === "verify"
                    ? session
                        .verifyEmailSignIn({ email: "person@example.test", code: "12345678" })
                        .pipe(Effect.as("verified"))
                    : session.currentIdentity.pipe(Effect.as("adopted"));
              const attempt = yield* Effect.result(task).pipe(Effect.forkScoped);
              yield* Deferred.await(entered);
              yield* TestClock.adjust("15 seconds");
              const result = yield* Fiber.join(attempt);
              if (point === "sign-out") {
                assert.equal(result._tag, "Success");
                if (result._tag === "Success") assert.equal(result.success, "revoke-failed");
                assert.deepEqual([...memory.values.keys()], []);
              } else {
                assert.equal(result._tag, "Failure");
                if (result._tag === "Failure") {
                  assert.instanceOf(result.failure, CliSession.CloudCliRelayUnavailableError);
                }
                assert.isUndefined(memory.read(CliSession.CLOUD_RELAY_SESSION_SECRET));
                if (point !== "verify") {
                  assert.equal(memory.read(CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET), encoded);
                }
              }
              // A second process/service can update credentials immediately.
              yield* withSecretStoreLock(directory, "cloud-cli-session", Effect.void);
            }),
          );
        }),
      ),
  );

  it.effect.each(["clerk", "relay"] as const)(
    "times out a stalled %s response body and releases the credential lease",
    (point) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "clerk-cli-body-timeout-",
          });
          const entered = yield* Deferred.make<void>();
          const relay = makeFakeRelay({
            [CLERK_TOKEN_URL]: [
              { status: 200, body: { access_token: "clerk-at-2", expires_in: 3_600 } },
            ],
            [`${RELAY_URL}/v1/auth/clerk-exchange`]: [
              { status: 200, body: sessionResponse("at-1") },
            ],
          });
          relay.stallBody = true;
          relay.beforeReply = () => Deferred.succeed(entered, undefined).pipe(Effect.asVoid);
          const encoded = legacyCredential(
            point === "clerk" ? 0 : (yield* Clock.currentTimeMillis) + 3_600_000,
          );
          const memory = makeMemorySecretStore({
            [CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET]: encoded,
          });
          yield* withSession(relay, { ...memory.store, directory }, (session) =>
            Effect.gen(function* () {
              const attempt = yield* Effect.flip(session.currentIdentity).pipe(Effect.forkScoped);
              yield* Deferred.await(entered);
              yield* TestClock.adjust("15 seconds");
              assert.instanceOf(
                yield* Fiber.join(attempt),
                CliSession.CloudCliRelayUnavailableError,
              );
              assert.equal(memory.read(CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET), encoded);
              assert.isUndefined(memory.read(CliSession.CLOUD_RELAY_SESSION_SECRET));
              yield* withSecretStoreLock(directory, "cloud-cli-session", Effect.void);
            }),
          );
        }),
      ),
  );

  it.effect.each([false, true])(
    "serializes two services and re-reads the winning session or rotated grant (first exchange succeeds: %s)",
    (succeeds) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "clerk-cli-adoption-",
          });
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const secondRead = yield* Deferred.make<void>();
          const relay = makeFakeRelay({
            [CLERK_TOKEN_URL]: [
              {
                status: 200,
                body: {
                  access_token: "clerk-at-2",
                  refresh_token: "clerk-rt-2",
                  expires_in: 3_600,
                },
              },
              { status: 400, body: { error: "invalid_grant" } },
            ],
            [`${RELAY_URL}/v1/auth/clerk-exchange`]: [
              succeeds ? { status: 200, body: sessionResponse("at-1") } : "network-error",
              { status: 200, body: sessionResponse("at-1") },
            ],
            [`${RELAY_URL}/v1/auth/token`]: [{ status: 200, body: tokenResponse("at-2") }],
          });
          relay.beforeReply = (request) =>
            request.url === CLERK_TOKEN_URL
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void;
          const memory = makeMemorySecretStore({
            [CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET]: legacyCredential(),
          });
          const secrets = { ...memory.store, directory };
          const secondSecrets = {
            ...secrets,
            get: (name: string) =>
              secrets
                .get(name)
                .pipe(
                  Effect.tap(() =>
                    name === CliSession.CLOUD_RELAY_SESSION_SECRET
                      ? Deferred.succeed(secondRead, undefined)
                      : Effect.void,
                  ),
                ),
          };
          yield* withSession(relay, secrets, (first) =>
            withSession(relay, secondSecrets, (second) =>
              Effect.gen(function* () {
                const firstAttempt = yield* Effect.result(first.currentIdentity).pipe(
                  Effect.forkScoped,
                );
                yield* Deferred.await(entered);
                const secondAttempt = yield* second.currentIdentity.pipe(Effect.forkScoped);
                yield* Deferred.await(secondRead);
                yield* Deferred.succeed(release, undefined);
                const outcome = yield* Fiber.join(firstAttempt);
                assert.equal(outcome._tag, succeeds ? "Success" : "Failure");
                assert.isTrue(Option.isSome(yield* Fiber.join(secondAttempt)));
                assert.lengthOf(requestsTo(relay, CLERK_TOKEN_URL), 1);
                assert.lengthOf(
                  requestsTo(relay, `${RELAY_URL}/v1/auth/clerk-exchange`),
                  succeeds ? 1 : 2,
                );
                assert.deepInclude(
                  JSON.parse(memory.read(CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET)!),
                  { refreshToken: "clerk-rt-2" },
                );
                assert.isDefined(memory.read(CliSession.CLOUD_RELAY_SESSION_SECRET));
              }),
            ),
          );
        }),
      ),
  );

  it.effect.each([
    "clerk-refused",
    "exchange-refused",
    "exchange-missing",
    "unreadable-token",
    "missing-clerk-config",
  ] as const)(
    "email verification recovers from %s and prevents future legacy adoption",
    (scenario) =>
      Effect.gen(function* () {
        const relay = makeFakeRelay({
          [CLERK_TOKEN_URL]: [{ status: 400, body: { error: "invalid_client" } }],
          [`${RELAY_URL}/v1/auth/clerk-exchange`]: [
            { status: scenario === "exchange-missing" ? 404 : 403, body: {} },
          ],
          [`${RELAY_URL}/v1/auth/token`]: [
            {
              status: 401,
              body: relayError("RelayAuthInvalidError", {
                code: "auth_invalid",
                reason: "invalid_session",
              }),
            },
          ],
        });
        const encoded =
          scenario === "unreadable-token"
            ? "not-json"
            : legacyCredential(
                scenario.startsWith("exchange") ? (yield* Clock.currentTimeMillis) + 3_600_000 : 0,
              );
        const secrets = makeMemorySecretStore({
          [CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET]: encoded,
        });
        return yield* withSession(
          relay,
          secrets.store,
          (session) =>
            Effect.gen(function* () {
              const error = yield* Effect.flip(session.currentIdentity);
              assert.equal(
                error._tag,
                scenario.startsWith("exchange")
                  ? "CloudCliRelayRejectedError"
                  : scenario === "clerk-refused"
                    ? "CloudCliClerkRefreshRejectedError"
                    : scenario === "missing-clerk-config"
                      ? "CloudCliLegacyClerkConfigError"
                      : "CloudCliSessionStorageError",
              );
              const identity = yield* signIn(session);
              assert.equal(identity.email, "person@example.test");
              assert.equal(secrets.read(CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET), encoded);
              assert.equal(secrets.read("cloud-cli-clerk-adopted"), "1");
              const adoptionRequests = relay.requests.filter(
                (r) => r.url === CLERK_TOKEN_URL || r.url.endsWith("/clerk-exchange"),
              ).length;
              yield* TestClock.adjust("29 minutes");
              assert.isTrue(Option.isNone(yield* session.currentIdentity));
              assert.isTrue(Option.isNone(yield* session.currentIdentity));
              assert.isFalse(yield* session.hasCredential);
              assert.equal(
                relay.requests.filter(
                  (r) => r.url === CLERK_TOKEN_URL || r.url.endsWith("/clerk-exchange"),
                ).length,
                adoptionRequests,
              );
            }),
          scenario === "missing-clerk-config" ? { T3CODE_RELAY_URL: RELAY_URL } : TEST_ENV,
        );
      }),
  );

  it.effect(
    "treats a session from another relay as signed out and signs in to the configured relay",
    () => {
      const otherRelay = "https://other-relay.example.test";
      const relay = makeFakeRelay({
        [`${otherRelay}/v1/auth/email/start`]: [
          { status: 200, body: { expiresAt: "1970-01-01T00:10:00.000Z", resendAfterSeconds: 30 } },
        ],
        [`${otherRelay}/v1/auth/email/verify`]: [
          {
            status: 200,
            body: { ...sessionResponse("other-at"), refresh_token: "styal_rt_other_secret" },
          },
        ],
      });
      const secrets = makeMemorySecretStore();
      return withSession(relay, secrets.store, (original) =>
        Effect.gen(function* () {
          yield* signIn(original);
          const before = relay.requests.length;
          assert.isTrue(
            Option.isNone(yield* original.authorize("GET", `${otherRelay}/v1/client/environments`)),
          );
          assert.isTrue(Option.isNone(yield* original.authorize("GET", "not-a-url")));
          assert.equal(relay.requests.length, before);
          yield* withSession(
            relay,
            secrets.store,
            (session) =>
              Effect.gen(function* () {
                assert.isFalse(yield* session.hasCredential);
                assert.isTrue(Option.isNone(yield* session.storedIdentity));
                assert.isTrue(Option.isNone(yield* session.currentIdentity));
                assert.isTrue(
                  Option.isNone(
                    yield* session.authorize("GET", `${otherRelay}/v1/client/environments`),
                  ),
                );
                assert.equal(relay.requests.length, before);
                const identity = yield* signIn(session);
                assert.equal(identity.relayUrl, otherRelay);
                assert.equal(
                  decodePersistedSession(secrets.read(CliSession.CLOUD_RELAY_SESSION_SECRET))
                    .relayUrl,
                  otherRelay,
                );
                assert.lengthOf(requestsTo(relay, `${otherRelay}/v1/auth/email/verify`), 1);
                assert.isTrue(
                  Option.isSome(
                    yield* session.authorize("GET", `${otherRelay}/v1/client/environments`),
                  ),
                );
                assert.isTrue(
                  Option.isNone(
                    yield* session.authorize("GET", `${RELAY_URL}/v1/client/environments`),
                  ),
                );
              }),
            { ...TEST_ENV, T3CODE_RELAY_URL: otherRelay },
          );
        }),
      );
    },
  );

  it.effect("startup skips credential recovery when there is no credential", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checked = yield* Deferred.make<void>();
        let attempts = 0;
        const relay = makeFakeRelay();
        const secrets = makeMemorySecretStore();
        yield* withSession(relay, secrets.store, (session) =>
          Effect.gen(function* () {
            yield* Layer.build(
              CliSession.layerStartupAdoption.pipe(
                Layer.provide(
                  Layer.succeed(CliSession.CloudCliSession, {
                    ...session,
                    hasCredential: session.hasCredential.pipe(
                      Effect.tap(() => Deferred.succeed(checked, undefined)),
                    ),
                    currentIdentity: Effect.suspend(() => {
                      attempts += 1;
                      return session.currentIdentity;
                    }),
                  }),
                ),
              ),
            );
            yield* Deferred.await(checked);
          }),
        );
        assert.equal(attempts, 0);
        assert.isEmpty(relay.requests);
        assert.equal(secrets.values.size, 0);
      }),
    ),
  );

  it.effect("startup retries a busy credential lease and completes adoption", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failed = yield* Deferred.make<void>();
        const adopted = yield* Deferred.make<void>();
        let attempts = 0;
        const relay = makeFakeRelay({
          [`${RELAY_URL}/v1/auth/clerk-exchange`]: [{ status: 200, body: sessionResponse("at-1") }],
        });
        const secrets = makeMemorySecretStore({
          [CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET]: legacyCredential(
            (yield* Clock.currentTimeMillis) + 3_600_000,
          ),
        });
        yield* withSession(relay, secrets.store, (session) =>
          Effect.gen(function* () {
            yield* Layer.build(
              CliSession.layerStartupAdoption.pipe(
                Layer.provide(
                  Layer.succeed(CliSession.CloudCliSession, {
                    ...session,
                    currentIdentity: Effect.suspend(() =>
                      ++attempts === 1
                        ? Deferred.succeed(failed, undefined).pipe(
                            Effect.andThen(
                              Effect.fail(
                                new CliSession.CloudCliSessionStorageError({
                                  cause: new SecretStoreLockError({
                                    resource: "cloud-cli-session",
                                    reason: "busy",
                                  }),
                                }),
                              ),
                            ),
                          )
                        : session.currentIdentity.pipe(
                            Effect.tap(() => Deferred.succeed(adopted, undefined)),
                          ),
                    ),
                  }),
                ),
              ),
            );
            yield* Deferred.await(failed);
            yield* TestClock.adjust("1 second");
            yield* Deferred.await(adopted);
            assert.equal(attempts, 2);
            assert.isDefined(secrets.read(CliSession.CLOUD_RELAY_SESSION_SECRET));
          }),
        );
      }),
    ),
  );

  it.effect("stores the relay session after a verified code and reuses the access token", () => {
    const relay = makeFakeRelay();
    const secrets = makeMemorySecretStore();
    return withSession(relay, secrets.store, (session) =>
      Effect.gen(function* () {
        const identity = yield* signIn(session);
        assert.deepEqual(identity, {
          userId: "user_1",
          email: "person@example.test",
          relayUrl: RELAY_URL,
        });

        const stored = decodePersistedSession(secrets.read(CliSession.CLOUD_RELAY_SESSION_SECRET));
        assert.equal(stored.refreshToken, "styal_rt_session1_secret");
        assert.equal(stored.email, "person@example.test");
        assert.isDefined(secrets.read(CliSession.CLOUD_CLI_DPOP_KEY_SECRET));
        // The code request and its redemption are signed by the same key.
        assert.lengthOf(relay.proofThumbprints, 2);
        assert.equal(relay.proofThumbprints[0], relay.proofThumbprints[1]);
        const [verify] = requestsTo(relay, `${RELAY_URL}/v1/auth/email/verify`);
        assert.deepInclude(JSON.parse(verify!.body), {
          email: "person@example.test",
          code: "12345678",
          client_id: "t3-cli",
        });

        const url = `${RELAY_URL}/v1/client/environment-links/env-1`;
        const headers = yield* session.authorize("DELETE", url);
        assert.isTrue(Option.isSome(headers));
        const { authorization, dpop } = Option.getOrThrow(headers);
        assert.equal(authorization, "DPoP at-1");
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
        assert.deepInclude(
          verifyDpopProof({
            proof: dpop,
            method: "DELETE",
            url,
            nowEpochSeconds: now,
            expectedAccessToken: "at-1",
            expectedThumbprint: relay.proofThumbprints[0]!,
          }),
          { ok: true },
        );
        assert.lengthOf(requestsTo(relay, `${RELAY_URL}/v1/auth/token`), 0);
      }),
    );
  });

  it.effect("reports a wrong code without storing a session", () => {
    const relay = makeFakeRelay({
      [`${RELAY_URL}/v1/auth/email/verify`]: [
        {
          status: 400,
          body: relayError("RelaySignInCodeInvalidError", {
            code: "sign_in_code_invalid",
            reason: "incorrect",
          }),
        },
      ],
    });
    const secrets = makeMemorySecretStore();
    return withSession(relay, secrets.store, (session) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(signIn(session));
        assert.instanceOf(error, CliSession.CloudCliSignInCodeError);
        assert.equal((error as CliSession.CloudCliSignInCodeError).reason, "incorrect");
        assert.isUndefined(secrets.read(CliSession.CLOUD_RELAY_SESSION_SECRET));
      }),
    );
  });

  it.effect("refreshes a stale access token once and caches the result", () => {
    const relay = makeFakeRelay({
      [`${RELAY_URL}/v1/auth/token`]: [{ status: 200, body: tokenResponse("at-2") }],
    });
    const secrets = makeMemorySecretStore();
    return withSession(relay, secrets.store, (session) =>
      Effect.gen(function* () {
        yield* signIn(session);
        yield* TestClock.adjust(Duration.minutes(29));

        const url = `${RELAY_URL}/v1/client/environment-link-challenges`;
        const [first, second] = yield* Effect.all(
          [session.authorize("POST", url), session.authorize("POST", url)],
          { concurrency: "unbounded" },
        );
        assert.equal(Option.getOrThrow(first).authorization, "DPoP at-2");
        assert.equal(Option.getOrThrow(second).authorization, "DPoP at-2");
        const refreshes = requestsTo(relay, `${RELAY_URL}/v1/auth/token`);
        assert.lengthOf(refreshes, 1);
        assert.deepEqual(JSON.parse(refreshes[0]!.body), {
          refresh_token: "styal_rt_session1_secret",
        });
      }),
    );
  });

  it.effect("a refresh that reports a new email keeps a session another process stored", () => {
    const relay = makeFakeRelay({
      [`${RELAY_URL}/v1/auth/token`]: [
        {
          status: 200,
          body: {
            ...tokenResponse("at-2"),
            user: { id: "user_1", email: "renamed@example.test" },
          },
        },
      ],
    });
    const secrets = makeMemorySecretStore();
    return withSession(relay, secrets.store, (session) =>
      Effect.gen(function* () {
        yield* signIn(session);
        const stored = decodePersistedSession(secrets.read(CliSession.CLOUD_RELAY_SESSION_SECRET));
        const newer = JSON.stringify({
          ...stored,
          userId: "user_2",
          email: "other@example.test",
          refreshToken: "styal_rt_session2_secret",
        });
        // Another process signs in while this refresh is in flight.
        relay.beforeReply = (request) =>
          request.url === `${RELAY_URL}/v1/auth/token`
            ? secrets.store
                .set(CliSession.CLOUD_RELAY_SESSION_SECRET, new TextEncoder().encode(newer))
                .pipe(Effect.orDie)
            : Effect.void;
        yield* TestClock.adjust(Duration.minutes(29));

        yield* session.authorize("POST", `${RELAY_URL}/v1/client/environment-link-challenges`);
        assert.equal(secrets.read(CliSession.CLOUD_RELAY_SESSION_SECRET), newer);
      }),
    );
  });

  it.effect("treats a session the relay ended as signed out", () => {
    const relay = makeFakeRelay({
      [`${RELAY_URL}/v1/auth/token`]: [
        {
          status: 401,
          body: relayError("RelayAuthInvalidError", {
            code: "auth_invalid",
            reason: "invalid_session",
          }),
        },
      ],
    });
    const secrets = makeMemorySecretStore();
    return withSession(relay, secrets.store, (session) =>
      Effect.gen(function* () {
        yield* signIn(session);
        yield* TestClock.adjust(Duration.minutes(31));

        const headers = yield* session.authorize("POST", `${RELAY_URL}/v1/client/account`);
        assert.isTrue(Option.isNone(headers));
        assert.isFalse(yield* session.hasCredential);
        assert.isUndefined(secrets.read(CliSession.CLOUD_RELAY_SESSION_SECRET));
      }),
    );
  });

  it.effect("keeps the session when the relay cannot be reached", () => {
    const relay = makeFakeRelay({ [`${RELAY_URL}/v1/auth/token`]: ["network-error"] });
    const secrets = makeMemorySecretStore();
    return withSession(relay, secrets.store, (session) =>
      Effect.gen(function* () {
        yield* signIn(session);
        yield* TestClock.adjust(Duration.minutes(31));

        const error = yield* Effect.flip(
          session.authorize("POST", `${RELAY_URL}/v1/client/account`),
        );
        assert.instanceOf(error, CliSession.CloudCliRelayUnavailableError);
        assert.isDefined(secrets.read(CliSession.CLOUD_RELAY_SESSION_SECRET));
      }),
    );
  });

  it.effect("moves a stored Clerk credential to a relay session without prompting", () => {
    const relay = makeFakeRelay({
      [CLERK_TOKEN_URL]: [
        {
          status: 200,
          body: { access_token: "clerk-at-2", refresh_token: "clerk-rt-2", expires_in: 3_600 },
        },
      ],
      [`${RELAY_URL}/v1/auth/clerk-exchange`]: [{ status: 200, body: sessionResponse("at-1") }],
    });
    const secrets = makeMemorySecretStore({
      [CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET]: JSON.stringify({
        accessToken: "clerk-at-1",
        refreshToken: "clerk-rt-1",
        expiresAtEpochMs: 0,
      }),
    });
    return withSession(relay, secrets.store, (session) =>
      Effect.gen(function* () {
        assert.isTrue(yield* session.hasCredential);
        const headers = yield* session.authorize("POST", `${RELAY_URL}/v1/client/account`);
        assert.equal(Option.getOrThrow(headers).authorization, "DPoP at-1");

        const [clerkRefresh] = requestsTo(relay, CLERK_TOKEN_URL);
        const params = new URLSearchParams(clerkRefresh!.body);
        assert.equal(params.get("grant_type"), "refresh_token");
        assert.equal(params.get("refresh_token"), "clerk-rt-1");
        assert.equal(params.get("client_id"), "oauth_client_test");
        const [exchange] = requestsTo(relay, `${RELAY_URL}/v1/auth/clerk-exchange`);
        assert.deepInclude(JSON.parse(exchange!.body), {
          subject_token: "clerk-at-2",
          client_id: "t3-cli",
        });
        assert.deepInclude(JSON.parse(secrets.read(CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET)!), {
          accessToken: "clerk-at-2",
          refreshToken: "clerk-rt-2",
        });
        const stored = decodePersistedSession(secrets.read(CliSession.CLOUD_RELAY_SESSION_SECRET));
        assert.equal(stored.userId, "user_1");
      }),
    );
  });

  it.effect("drops a stored Clerk credential that Clerk no longer accepts", () => {
    const relay = makeFakeRelay({
      [CLERK_TOKEN_URL]: [{ status: 400, body: { error: "invalid_grant" } }],
    });
    const secrets = makeMemorySecretStore({
      [CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET]: JSON.stringify({
        accessToken: "clerk-at-1",
        refreshToken: "clerk-rt-1",
        expiresAtEpochMs: 0,
      }),
    });
    return withSession(relay, secrets.store, (session) =>
      Effect.gen(function* () {
        assert.isTrue(Option.isNone(yield* session.currentIdentity));
        assert.isUndefined(secrets.read(CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET));
        assert.lengthOf(requestsTo(relay, `${RELAY_URL}/v1/auth/clerk-exchange`), 0);
      }),
    );
  });

  it.effect("signs out locally even when the relay sign-out fails", () => {
    const relay = makeFakeRelay({
      [`${RELAY_URL}/v1/auth/sign-out`]: [
        {
          status: 500,
          body: relayError("RelayInternalError", {
            code: "internal_error",
            reason: "database_unavailable",
          }),
        },
      ],
    });
    const secrets = makeMemorySecretStore();
    return withSession(relay, secrets.store, (session) =>
      Effect.gen(function* () {
        yield* signIn(session);

        assert.equal(yield* session.signOut, "revoke-failed");
        const [signOut] = requestsTo(relay, `${RELAY_URL}/v1/auth/sign-out`);
        assert.deepEqual(JSON.parse(signOut!.body), { refresh_token: "styal_rt_session1_secret" });
        assert.deepEqual([...secrets.values.keys()], []);
        assert.isFalse(yield* session.hasCredential);
      }),
    );
  });
});
