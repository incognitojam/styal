// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync or sign.
import * as NodeCrypto from "node:crypto";

import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { RelayApi } from "@t3tools/contracts/relay";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
  verifyDpopProof,
} from "@t3tools/shared/dpop";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as AccountAuth from "../auth/AccountAuth.ts";
import * as AccountData from "../auth/AccountData.ts";
import * as Accounts from "../auth/Accounts.ts";
import * as AuthSessions from "../auth/AuthSessions.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as CloudMintSigner from "../auth/CloudMintSigner.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as Devices from "../agentActivity/Devices.ts";
import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinker from "../environments/EnvironmentLinker.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import * as T3ChatAccounts from "../t3chat/T3ChatAccounts.ts";
import * as ManagedTunnelLimits from "../environments/ManagedTunnelLimits.ts";
import * as RelayHttpApi from "./Api.ts";

const RELAY = "https://relay.example.test";

const mintKeys = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: RELAY,
  apns: null,
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  signInCodeSecret: Redacted.make("test-sign-in-code-secret"),
  cloudMintPrivateKey: Redacted.make(mintKeys.privateKey),
  cloudMintPublicKey: mintKeys.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});

const deviceKey = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const deviceJwk = deviceKey.publicKey.export({ format: "jwk" }) as DpopPublicJwk;
const deviceThumbprint = computeDpopJwkThumbprint(deviceJwk);

function dpopProof(method: string, url: string, accessToken?: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ typ: "dpop+jwt", alg: "ES256", jwk: deviceJwk });
  const payload = encode({
    htm: method,
    htu: url,
    jti: NodeCrypto.randomUUID(),
    // @effect-diagnostics-next-line globalDate:off -- proofs are signed outside Effect, against the live clock the handler uses.
    iat: Math.floor(Date.now() / 1_000), // oxlint-disable-line t3code/no-wall-clock-in-tests -- signed outside Effect against the live clock the handler verifies with
    ...(accessToken ? { ath: computeDpopAccessTokenHash(accessToken) } : {}),
  });
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: deviceKey.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

// Real proof verification with an in-memory replay set.
const layerProofReplay = Layer.sync(DpopProofs.DpopProofReplay, () => {
  const consumed = new Set<string>();
  return DpopProofs.DpopProofReplay.of({
    verifyAndConsume: (input) => {
      const result = verifyDpopProof({
        proof: input.proof,
        method: input.method,
        url: input.url,
        nowEpochSeconds: Math.floor(input.now.epochMilliseconds / 1_000),
        ...(input.expectedThumbprint ? { expectedThumbprint: input.expectedThumbprint } : {}),
        ...(input.expectedAccessToken ? { expectedAccessToken: input.expectedAccessToken } : {}),
      });
      if (!result.ok) return Effect.fail(new DpopProofs.DpopProofRejected({ code: result.code }));
      if (consumed.has(result.jti)) {
        return Effect.fail(new DpopProofs.DpopProofRejected({ code: "replayed" }));
      }
      consumed.add(result.jti);
      return Effect.succeed(result.thumbprint);
    },
    consume: () => Effect.succeed(true),
    pruneExpired: Effect.void,
  });
});

const deletedAccounts: Array<{ readonly userId: string; readonly email: string | null }> = [];

interface AppOptions {
  readonly config?: RelayConfiguration.RelayConfiguration["Service"];
  readonly accountData?: Partial<AccountData.AccountData["Service"]>;
  readonly links?: Partial<EnvironmentLinks.EnvironmentLinks["Service"]>;
  readonly provider?: Partial<ManagedEndpointProvider.ManagedEndpointProvider["Service"]>;
  readonly inbox?: Partial<HookInbox.HookInbox["Service"]>;
  readonly liveSessionIds?: ReadonlyArray<string>;
}

function makeApp(
  accountAuth: Partial<AccountAuth.AccountAuth["Service"]>,
  options: AppOptions = {},
) {
  const services = Layer.mergeAll(
    Layer.mock(AccountData.AccountData, {
      listEnvironmentIds: () => Effect.succeed([]),
      deleteForUser: (input) =>
        Effect.sync(() => {
          deletedAccounts.push(input);
        }),
      ...options.accountData,
    }),
    Layer.succeed(RelayConfiguration.RelayConfiguration, options.config ?? config),
    NodeCryptoLayer.layer,
    layerProofReplay,
    Layer.mock(AccountAuth.AccountAuth, accountAuth),
    Layer.mock(Accounts.Accounts, {
      get: (userId) => Effect.succeedSome({ userId, email: "someone@example.com" }),
    }),
    Layer.mock(AuthSessions.AuthSessions, {
      isLive: ({ sessionId }) =>
        Effect.succeed((options.liveSessionIds ?? ["session-current"]).includes(sessionId)),
      listForUser: (userId) =>
        Effect.succeed([
          {
            sessionId: "session-current",
            userId,
            clientId: "t3-web" as const,
            label: "Laptop",
            createdAt: "2026-10-01T00:00:00.000Z",
            lastUsedAt: "2026-10-18T00:00:00.000Z",
          },
          {
            sessionId: "session-other",
            userId,
            clientId: "t3-mobile" as const,
            label: null,
            createdAt: "2026-10-02T00:00:00.000Z",
            lastUsedAt: "2026-10-17T00:00:00.000Z",
          },
        ]),
    }),
    Layer.mock(EnvironmentLinker.EnvironmentLinker, {}),
    Layer.mock(EnvironmentLinks.EnvironmentLinks, {
      listForUser: ({ userId }) => {
        expect(userId).toBe("usr_dpop");
        return Effect.succeed([]);
      },
      ...options.links,
    }),
    Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, options.provider ?? {}),
    Layer.mock(HookInbox.HookInbox, options.inbox ?? {}),
    Layer.mock(EnvironmentCredentials.EnvironmentCredentials, {
      revokeForEnvironmentPublicKey: () => Effect.succeed(true),
    }),
    Layer.mock(RelayDb.RelayTransactions, { withTransaction: (effect) => effect }),
    Layer.mock(Devices.Devices, {}),
    Layer.mock(T3ChatAccounts.T3ChatAccounts, { available: false }),
    Layer.mock(ManagedTunnelLimits.ManagedTunnelLimits, {}),
  ).pipe(
    Layer.provideMerge(
      RelayTokens.layer.pipe(
        Layer.provideMerge(CloudMintSigner.layer),
        Layer.provide(Layer.mergeAll(RelayConfiguration.layer(config), NodeCryptoLayer.layer)),
      ),
    ),
  );

  const handlers = Layer.mergeAll(RelayHttpApi.layerClientApi, RelayHttpApi.layerAuthApi).pipe(
    HttpRouter.provideRequest(services),
    Layer.provideMerge(RelayHttpApi.layerClientAuth),
    Layer.provide(services),
  );
  return HttpRouter.toWebHandler(
    HttpApiBuilder.layer(
      HttpApi.make("RelayApi").add(RelayApi.groups.client, RelayApi.groups.auth),
    ).pipe(Layer.provide(handlers), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );
}

const issueAccessToken = (
  scopes: ReadonlyArray<"account" | "environment:connect">,
  userId = "usr_dpop",
  sessionId: string | null = "session-current",
) =>
  Effect.gen(function* () {
    const tokens = yield* RelayTokens.RelayTokens;
    const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    return yield* tokens.issueDpopAccessToken({
      userId,
      proofKeyThumbprint: deviceThumbprint,
      jti: NodeCrypto.randomUUID(),
      issuedAtEpochSeconds: now,
      expiresAtEpochSeconds: now + 600,
      clientId: "t3-web",
      scopes,
      ...(sessionId === null ? {} : { sessionId }),
    });
  }).pipe(
    Effect.provide(
      RelayTokens.layer.pipe(
        Layer.provideMerge(CloudMintSigner.layer),
        Layer.provide(Layer.mergeAll(RelayConfiguration.layer(config), NodeCryptoLayer.layer)),
      ),
    ),
  );

const withApp = <A, E>(
  accountAuth: Partial<AccountAuth.AccountAuth["Service"]>,
  body: (app: ReturnType<typeof makeApp>) => Effect.Effect<A, E>,
  options?: AppOptions,
) =>
  Effect.acquireRelease(
    Effect.sync(() => makeApp(accountAuth, options)),
    (app) => Effect.promise(() => app.dispose()),
  ).pipe(Effect.flatMap(body), Effect.scoped);

// The relay rebuilds the URL a proof covers from these headers, as Cloudflare sends them.
const send = (app: ReturnType<typeof makeApp>, request: Request) =>
  Effect.promise(async () => {
    const headers = new Headers(request.headers);
    headers.set("host", new URL(RELAY).host);
    headers.set("x-forwarded-proto", "https");
    const response = await app.handler(new Request(request, { headers }));
    return { response, body: (await response.json()) as Record<string, unknown> };
  });

describe("client endpoints over DPoP", () => {
  it.live("refuse bearer credentials and a correctly signed legacy token without a session", () =>
    Effect.gen(function* () {
      const legacy = yield* issueAccessToken(["account"], "usr_dpop", null);
      yield* withApp({}, (app) =>
        Effect.gen(function* () {
          const url = `${RELAY}/v1/environments`;
          for (const authorization of ["Bearer retired-credential", `DPoP ${legacy}`]) {
            const { response } = yield* send(
              app,
              new Request(url, { headers: { authorization, dpop: dpopProof("GET", url, legacy) } }),
            );
            expect(response.status).toBe(401);
          }
        }),
      );
    }),
  );
  it.live("serve no legacy exchange routes", () =>
    withApp({}, (app) =>
      Effect.promise(async () => {
        for (const path of ["/v1/client/dpop-token", "/v1/auth/clerk-exchange"]) {
          const response = await app.handler(
            new Request(`${RELAY}${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ subject_token: "retired", client_id: "t3-web" }),
            }),
          );
          expect(response.status).toBe(404);
        }
      }),
    ),
  );

  it.live("accept an account-scoped access token with a matching proof, using a live session", () =>
    Effect.gen(function* () {
      const accessToken = yield* issueAccessToken(["account"]);
      yield* withApp({}, (app) =>
        Effect.gen(function* () {
          const url = `${RELAY}/v1/environments`;
          const { response, body } = yield* send(
            app,
            new Request(url, {
              headers: {
                authorization: `DPoP ${accessToken}`,
                dpop: dpopProof("GET", url, accessToken),
              },
            }),
          );
          expect(body).toEqual({ environments: [] });
          expect(response.status).toBe(200);
        }),
      );
    }),
  );

  it.live("mark the caller's own session in the sessions list", () =>
    Effect.gen(function* () {
      const accessToken = yield* issueAccessToken(["account"]);
      yield* withApp({}, (app) =>
        Effect.gen(function* () {
          const url = `${RELAY}/v1/client/sessions`;
          const { body } = yield* send(
            app,
            new Request(url, {
              headers: {
                authorization: `DPoP ${accessToken}`,
                dpop: dpopProof("GET", url, accessToken),
              },
            }),
          );
          expect(body.sessions).toMatchObject([
            { sessionId: "session-current", current: true },
            { sessionId: "session-other", current: false },
          ]);
        }),
      );
    }),
  );

  it.live("reject a token whose session was revoked, before it expires", () =>
    Effect.gen(function* () {
      const accessToken = yield* issueAccessToken(["account"]);
      yield* withApp(
        {},
        (app) =>
          Effect.gen(function* () {
            const url = `${RELAY}/v1/environments`;
            const { response, body } = yield* send(
              app,
              new Request(url, {
                headers: {
                  authorization: `DPoP ${accessToken}`,
                  dpop: dpopProof("GET", url, accessToken),
                },
              }),
            );
            expect(response.status).toBe(401);
            expect(body).toMatchObject({ code: "auth_invalid", reason: "invalid_session" });
          }),
        { liveSessionIds: [] },
      );
    }),
  );

  it.live("reject a missing proof and a token without the account scope", () =>
    Effect.gen(function* () {
      const accountToken = yield* issueAccessToken(["account"]);
      const connectToken = yield* issueAccessToken(["environment:connect"]);
      yield* withApp({}, (app) =>
        Effect.gen(function* () {
          const url = `${RELAY}/v1/environments`;
          const missingProof = yield* send(
            app,
            new Request(url, { headers: { authorization: `DPoP ${accountToken}` } }),
          );
          expect(missingProof.response.status).toBe(401);
          expect(missingProof.body).toMatchObject({ code: "auth_invalid", reason: "invalid_dpop" });

          const wrongScope = yield* send(
            app,
            new Request(url, {
              headers: {
                authorization: `DPoP ${connectToken}`,
                dpop: dpopProof("GET", url, connectToken),
              },
            }),
          );
          expect(wrongScope.response.status).toBe(401);
        }),
      );
    }),
  );
});

describe("account deletion", () => {
  it.live("retries teardown targets from account data before deleting relay records", () =>
    Effect.gen(function* () {
      deletedAccounts.length = 0;
      const accessToken = yield* issueAccessToken(["account"]);
      const attempted: Array<string> = [];
      let failedOnce = false;
      yield* withApp(
        {},
        (app) =>
          Effect.gen(function* () {
            const request = () => {
              const url = `${RELAY}/v1/client/account`;
              return new Request(url, {
                method: "DELETE",
                headers: {
                  authorization: `DPoP ${accessToken}`,
                  dpop: dpopProof("DELETE", url, accessToken),
                },
              });
            };
            const first = yield* send(app, request());
            expect(first.response.status).toBe(500);
            expect(first.body).toMatchObject({ reason: "upstream_unavailable" });
            expect(deletedAccounts).toEqual([]);
            expect((yield* send(app, request())).response.status).toBe(200);
            expect(attempted).toEqual(["env_revoked", "env_revoked", "env_allocation_only"]);
            expect(deletedAccounts).toHaveLength(1);
          }),
        {
          accountData: {
            listEnvironmentIds: () => Effect.succeed(["env_revoked", "env_allocation_only"]),
          },
          links: { getForUser: () => Effect.succeed(null) },
          provider: {
            prepareDeprovision: () => Effect.succeed(null),
            deprovision: (input) =>
              Effect.gen(function* () {
                attempted.push(input.environmentId);
                if (!failedOnce) {
                  failedOnce = true;
                  return yield* new ManagedEndpointProvider.ManagedEndpointDeprovisioningFailed({
                    userId: input.userId,
                    environmentId: input.environmentId,
                    stage: "delete-tunnel",
                    cause: "Synthetic outage",
                  });
                }
                return true;
              }),
          },
        },
      );
    }),
  );

  it.live("deletes the caller's own account data", () =>
    Effect.gen(function* () {
      deletedAccounts.length = 0;
      const accessToken = yield* issueAccessToken(["account"]);
      yield* withApp({}, (app) =>
        Effect.gen(function* () {
          const url = `${RELAY}/v1/client/account`;
          const { response, body } = yield* send(
            app,
            new Request(url, {
              method: "DELETE",
              headers: {
                authorization: `DPoP ${accessToken}`,
                dpop: dpopProof("DELETE", url, accessToken),
              },
            }),
          );
          expect(response.status).toBe(200);
          expect(body).toEqual({ ok: true });
          expect(deletedAccounts).toEqual([{ userId: "usr_dpop", email: "someone@example.com" }]);
        }),
      );
    }),
  );
});

describe("auth endpoints", () => {
  const post = (path: string, payload: unknown) => {
    const url = `${RELAY}${path}`;
    return new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", dpop: dpopProof("POST", url) },
      body: JSON.stringify(payload),
    });
  };

  it.live("bind sign-in to the proof key and return a session without caching", () =>
    withApp(
      {
        verifyEmailSignIn: (input) => {
          expect(input.thumbprint).toBe(deviceThumbprint);
          expect(input.clientId).toBe("t3-mobile");
          return Effect.succeed({
            accessToken: "access",
            expiresInSeconds: 1800,
            scopes: ["account"],
            user: { id: "usr_1", email: "someone@example.com" },
            sessionId: "session-1",
            refreshToken: "styal_rt_session",
          });
        },
      },
      (app) =>
        Effect.gen(function* () {
          const { response, body } = yield* send(
            app,
            post("/v1/auth/email/verify", {
              email: "someone@example.com",
              code: "12345678",
              client_id: "t3-mobile",
            }),
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(body).toEqual({
            access_token: "access",
            token_type: "DPoP",
            expires_in: 1800,
            scope: "account",
            user: { id: "usr_1", email: "someone@example.com" },
            refresh_token: "styal_rt_session",
            session_id: "session-1",
          });
        }),
    ),
  );

  it.live("map sign-in failures to client-readable errors", () =>
    withApp(
      {
        startEmailSignIn: () =>
          Effect.fail(new AccountAuth.SignInRateLimited({ retryAfterSeconds: 42 })),
        verifyEmailSignIn: () =>
          Effect.fail(new AccountAuth.SignInCodeRejected({ reason: "too_many_attempts" })),
        refresh: () => Effect.fail(new AccountAuth.AuthSessionInvalid({})),
      },
      (app) =>
        Effect.gen(function* () {
          const limited = yield* send(
            app,
            post("/v1/auth/email/start", { email: "a@example.com", client_id: "t3-web" }),
          );
          expect(limited.response.status).toBe(429);
          expect(limited.response.headers.get("retry-after")).toBe("42");
          expect(limited.body).toMatchObject({ code: "auth_rate_limited", retryAfterSeconds: 42 });

          const rejected = yield* send(
            app,
            post("/v1/auth/email/verify", {
              email: "a@example.com",
              code: "12345678",
              client_id: "t3-web",
            }),
          );
          expect(rejected.response.status).toBe(400);
          expect(rejected.body).toMatchObject({
            code: "sign_in_code_invalid",
            reason: "too_many_attempts",
          });

          const refresh = yield* send(app, post("/v1/auth/token", { refresh_token: "styal_rt_x" }));
          expect(refresh.response.status).toBe(401);
          expect(refresh.body).toMatchObject({ code: "auth_invalid", reason: "invalid_session" });
        }),
    ),
  );

  it.live("refuse sign-in without a DPoP proof", () =>
    withApp({ startEmailSignIn: () => Effect.die("must not run without a proof") }, (app) =>
      Effect.gen(function* () {
        const { response, body } = yield* send(
          app,
          new Request(`${RELAY}/v1/auth/email/start`, {
            method: "POST",
            headers: { "content-type": "application/json", dpop: "not-a-proof" },
            body: JSON.stringify({ email: "a@example.com", client_id: "t3-web" }),
          }),
        );
        expect(response.status).toBe(401);
        expect(body).toMatchObject({ code: "auth_invalid", reason: "invalid_dpop" });
      }),
    ),
  );
});
