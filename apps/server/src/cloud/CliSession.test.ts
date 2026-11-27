import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CliSession from "./CliSession.ts";

const RELAY_URL = "https://relay.example.test";

const TEST_ENV = {
  T3CODE_RELAY_URL: RELAY_URL,
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

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("CliSession", (it) => {
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
  it.effect("returns the refreshed email on the same identity lookup", () => {
    const relay = makeFakeRelay({
      [`${RELAY_URL}/v1/auth/token`]: [
        {
          status: 200,
          body: { ...tokenResponse("at-2"), user: { id: "user_1", email: "ada@example.test" } },
        },
      ],
    });
    const secrets = makeMemorySecretStore();
    return withSession(relay, secrets.store, (session) =>
      Effect.gen(function* () {
        yield* signIn(session);
        yield* TestClock.adjust(Duration.minutes(29));
        assert.equal(Option.getOrThrow(yield* session.currentIdentity).email, "ada@example.test");
        assert.equal(Option.getOrThrow(yield* session.storedIdentity).email, "ada@example.test");
      }),
    );
  });
  it.effect("ignores a legacy Clerk credential and signs in again with email", () => {
    const relay = makeFakeRelay();
    const credential = JSON.stringify({
      accessToken: "legacy-at",
      refreshToken: "legacy-rt",
      expiresAtEpochMs: 0,
    });
    const secrets = makeMemorySecretStore({ "cloud-cli-oauth-token": credential });
    return withSession(relay, secrets.store, (session) =>
      Effect.gen(function* () {
        assert.isFalse(yield* session.hasCredential);
        assert.isTrue(Option.isNone(yield* session.currentIdentity));
        assert.isEmpty(relay.requests);
        yield* signIn(session);
        assert.equal(secrets.read("cloud-cli-oauth-token"), credential);
        assert.isFalse(relay.requests.some((r) => r.url.includes("clerk-exchange")));
        yield* session.signOut;
        assert.isUndefined(secrets.read("cloud-cli-oauth-token"));
      }),
    );
  });
});
