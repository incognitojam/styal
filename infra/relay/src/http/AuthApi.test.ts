// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync or sign.
import * as NodeCrypto from "node:crypto";

import { createClerkClient, verifyToken } from "@clerk/backend";
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
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { vi } from "vite-plus/test";

import * as AccountAuth from "../auth/AccountAuth.ts";
import * as AccountData from "../auth/AccountData.ts";
import * as Accounts from "../auth/Accounts.ts";
import * as AuthSessions from "../auth/AuthSessions.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as Devices from "../agentActivity/Devices.ts";
import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinker from "../environments/EnvironmentLinker.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import * as RelayHttpApi from "./Api.ts";

vi.mock("@clerk/backend", () => ({
  createClerkClient: vi.fn(),
  verifyToken: vi.fn(),
}));

const RELAY = "https://relay.example.test";

const mintKeys = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: RELAY,
  apns: null,
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
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
    iat: Math.floor(Date.now() / 1_000),
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
      get: (userId) => Effect.succeed(Option.some({ userId, email: "someone@example.com" })),
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
  ).pipe(
    Layer.provideMerge(RelayTokens.layer.pipe(Layer.provide(RelayConfiguration.layer(config)))),
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
      sessionId: "session-current",
    });
  }).pipe(Effect.provide(RelayTokens.layer.pipe(Layer.provide(RelayConfiguration.layer(config)))));

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
  it.live("accept an account-scoped access token with a matching proof, without Clerk", () =>
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
          expect(verifyToken).not.toHaveBeenCalled();
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

  it.live.each([new TypeError("fetch failed"), { status: 503 }, { status: 429 }])(
    "keeps relay data and sessions when Clerk deletion fails after teardown (%s), then retries",
    (failure) =>
      Effect.gen(function* () {
        deletedAccounts.length = 0;
        const accessToken = yield* issueAccessToken(["account"], "user_clerk");
        const deleteUser = vi
          .fn()
          .mockRejectedValueOnce(failure)
          .mockRejectedValueOnce({ status: 404 });
        vi.mocked(createClerkClient).mockReturnValue({
          users: { deleteUser },
        } as unknown as ReturnType<typeof createClerkClient>);
        let listed = 0;
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
              const failed = yield* send(app, request());
              expect(failed.response.status).toBe(500);
              expect(failed.body).toMatchObject({ reason: "upstream_unavailable" });
              expect(deletedAccounts).toEqual([]);
              expect(listed).toBe(1);
              const retry = yield* send(app, request());
              expect(retry.response.status).toBe(200);
              expect(deletedAccounts).toEqual([
                { userId: "user_clerk", email: "someone@example.com" },
              ]);
              expect(deleteUser).toHaveBeenNthCalledWith(2, "user_clerk");
              expect(listed).toBe(2);
            }),
          {
            accountData: {
              listEnvironmentIds: () =>
                Effect.sync(() => {
                  listed++;
                  return [];
                }),
            },
          },
        );
      }).pipe(Effect.ensuring(Effect.sync(() => vi.resetAllMocks()))),
  );

  it.live("keeps the Clerk user when environment teardown fails", () =>
    Effect.gen(function* () {
      deletedAccounts.length = 0;
      const accessToken = yield* issueAccessToken(["account"], "user_clerk");
      const deleteUser = vi.fn().mockResolvedValue({});
      vi.mocked(createClerkClient).mockReturnValue({
        users: { deleteUser },
      } as unknown as ReturnType<typeof createClerkClient>);
      yield* withApp(
        {},
        (app) =>
          Effect.gen(function* () {
            const url = `${RELAY}/v1/client/account`;
            const failed = yield* send(
              app,
              new Request(url, {
                method: "DELETE",
                headers: {
                  authorization: `DPoP ${accessToken}`,
                  dpop: dpopProof("DELETE", url, accessToken),
                },
              }),
            );
            expect(failed.response.status).toBe(500);
            expect(failed.body).toMatchObject({ reason: "upstream_unavailable" });
            expect(deleteUser).not.toHaveBeenCalled();
            expect(deletedAccounts).toEqual([]);
          }),
        {
          accountData: { listEnvironmentIds: () => Effect.succeed(["env_held"]) },
          links: { getForUser: () => Effect.succeed(null) },
          provider: {
            prepareDeprovision: () => Effect.succeed(null),
            deprovision: (input) =>
              Effect.fail(
                new ManagedEndpointProvider.ManagedEndpointDeprovisioningFailed({
                  userId: input.userId,
                  environmentId: input.environmentId,
                  stage: "delete-tunnel",
                  cause: "Synthetic outage",
                }),
              ),
          },
        },
      );
    }).pipe(Effect.ensuring(Effect.sync(() => vi.resetAllMocks()))),
  );

  it.live("skips Clerk deletion for an imported account when Clerk is not configured", () =>
    Effect.gen(function* () {
      const accessToken = yield* issueAccessToken(["account"], "user_clerk");
      yield* withApp(
        {},
        (app) =>
          Effect.gen(function* () {
            const url = `${RELAY}/v1/client/account`;
            const result = yield* send(
              app,
              new Request(url, {
                method: "DELETE",
                headers: {
                  authorization: `DPoP ${accessToken}`,
                  dpop: dpopProof("DELETE", url, accessToken),
                },
              }),
            );
            expect(result.response.status).toBe(200);
            expect(createClerkClient).not.toHaveBeenCalled();
          }),
        { config: { ...config, clerkSecretKey: Redacted.make("") } },
      );
    }).pipe(Effect.ensuring(Effect.sync(() => vi.resetAllMocks()))),
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

  const exchangeGrant = {
    accessToken: "access",
    expiresInSeconds: 1800,
    scopes: ["account"] as const,
    user: { id: "user_clerk", email: "current@example.com" },
    sessionId: "session",
    refreshToken: "refresh",
  };

  it.live("Clerk directory failures through exchange return upstream_unavailable", () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: "user_clerk",
      aud: config.clerkJwtAudience,
    } as unknown as Awaited<ReturnType<typeof verifyToken>>);
    vi.mocked(createClerkClient).mockReturnValue({
      users: {
        getUser: async () => {
          throw new TypeError("fetch failed");
        },
      },
    } as unknown as ReturnType<typeof createClerkClient>);
    return withApp(
      { openVerifiedSession: (input) => input.lookupEmail.pipe(Effect.as(exchangeGrant)) },
      (app) =>
        Effect.gen(function* () {
          const { response, body } = yield* send(
            app,
            post("/v1/auth/clerk-exchange", { subject_token: "jwt", client_id: "t3-web" }),
          );
          expect(response.status).toBe(500);
          expect(body).toMatchObject({ code: "internal_error", reason: "upstream_unavailable" });
        }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.resetAllMocks())));
  });

  it.live("Clerk exchange refuses a token for a user Clerk no longer has", () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: "user_deleted",
      aud: config.clerkJwtAudience,
    } as unknown as Awaited<ReturnType<typeof verifyToken>>);
    vi.mocked(createClerkClient).mockReturnValue({
      users: {
        getUser: async () => {
          throw { status: 404 };
        },
      },
    } as unknown as ReturnType<typeof createClerkClient>);
    const openVerifiedSession = vi.fn(() => Effect.succeed(exchangeGrant));
    return withApp({ openVerifiedSession }, (app) =>
      Effect.gen(function* () {
        const { response, body } = yield* send(
          app,
          post("/v1/auth/clerk-exchange", { subject_token: "jwt", client_id: "t3-web" }),
        );
        expect(response.status).toBe(401);
        expect(body).toMatchObject({ code: "auth_invalid", reason: "invalid_bearer" });
        expect(openVerifiedSession).not.toHaveBeenCalled();
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.resetAllMocks())));
  });

  it.live("Clerk exchange reads the current verified primary through the real lookup", () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: "user_clerk",
      aud: config.clerkJwtAudience,
    } as unknown as Awaited<ReturnType<typeof verifyToken>>);
    vi.mocked(createClerkClient).mockReturnValue({
      users: {
        getUser: async () => ({
          primaryEmailAddressId: "primary",
          emailAddresses: [
            {
              id: "secondary",
              emailAddress: "secondary@example.com",
              verification: { status: "verified" },
            },
            {
              id: "primary",
              emailAddress: "CURRENT@example.com",
              verification: { status: "verified" },
            },
          ],
        }),
      },
    } as unknown as ReturnType<typeof createClerkClient>);
    return withApp(
      {
        openVerifiedSession: (input) =>
          input.lookupEmail.pipe(
            Effect.map((email) => {
              expect(email).toEqual(Option.some("current@example.com"));
              return exchangeGrant;
            }),
          ),
      },
      (app) =>
        Effect.gen(function* () {
          const { response } = yield* send(
            app,
            post("/v1/auth/clerk-exchange", { subject_token: "jwt", client_id: "t3-web" }),
          );
          expect(response.status).toBe(200);
        }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.resetAllMocks())));
  });

  it.live.each([
    { label: "network", failure: new TypeError("fetch failed"), retryable: true },
    { label: "5xx", failure: { status: 503 }, retryable: true },
    { label: "JWKS", failure: { reason: "jwk-remote-failed-to-load" }, retryable: true },
    { label: "expired JWT", failure: { reason: "token-expired" }, retryable: false },
    {
      label: "invalid JWT signature",
      failure: { reason: "token-invalid-signature" },
      retryable: false,
    },
  ])("Clerk exchange classifies $label failures", ({ failure, retryable }) => {
    vi.mocked(verifyToken).mockRejectedValue(failure);
    return withApp({}, (app) =>
      Effect.gen(function* () {
        const { response, body } = yield* send(
          app,
          post("/v1/auth/clerk-exchange", { subject_token: "jwt", client_id: "t3-web" }),
        );
        expect(response.status).toBe(retryable ? 500 : 401);
        expect(body.reason).toBe(retryable ? "upstream_unavailable" : "invalid_bearer");
        expect(createClerkClient).not.toHaveBeenCalled();
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.resetAllMocks())));
  });

  it.live.each(["unexpected-error", "not_authenticated"])(
    "Clerk OAuth signed-out state %s preserves the failure category",
    (reason) => {
      vi.mocked(verifyToken).mockRejectedValue({ reason: "token-invalid" });
      vi.mocked(createClerkClient).mockReturnValue({
        authenticateRequest: async () => ({
          isAuthenticated: false,
          reason,
          toAuth: () => ({ userId: null }),
        }),
      } as unknown as ReturnType<typeof createClerkClient>);
      return withApp({}, (app) =>
        Effect.gen(function* () {
          const { response, body } = yield* send(
            app,
            post("/v1/auth/clerk-exchange", { subject_token: "oauth", client_id: "t3-cli" }),
          );
          expect(response.status).toBe(reason === "unexpected-error" ? 500 : 401);
          expect(body.reason).toBe(
            reason === "unexpected-error" ? "upstream_unavailable" : "invalid_bearer",
          );
        }),
      ).pipe(Effect.ensuring(Effect.sync(() => vi.resetAllMocks())));
    },
  );

  it.live("Clerk exchange rejects the wrong JWT audience without a network fallback", () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: "user_clerk",
      aud: "other-service",
    } as unknown as Awaited<ReturnType<typeof verifyToken>>);
    return withApp({}, (app) =>
      Effect.gen(function* () {
        const { response, body } = yield* send(
          app,
          post("/v1/auth/clerk-exchange", { subject_token: "jwt", client_id: "t3-web" }),
        );
        expect(response.status).toBe(401);
        expect(body.reason).toBe("invalid_bearer");
        expect(createClerkClient).not.toHaveBeenCalled();
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => vi.resetAllMocks())));
  });

  it.live("a directory outage after email redemption is not a code rejection", () =>
    withApp(
      {
        verifyEmailSignIn: () => Effect.fail(new AccountAuth.VerifiedEmailLookupFailed({})),
      },
      (app) =>
        Effect.gen(function* () {
          const { response, body } = yield* send(
            app,
            post("/v1/auth/email/verify", {
              email: "a@example.com",
              code: "12345678",
              client_id: "t3-web",
            }),
          );
          expect(response.status).toBe(500);
          expect(body).toMatchObject({ code: "internal_error", reason: "upstream_unavailable" });
        }),
    ),
  );

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
