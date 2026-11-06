import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { RelayApi } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as Runtime from "./Runtime.ts";
import * as RelayDb from "./db.ts";
import * as RelayConfiguration from "./Config.ts";
import * as AccountAuth from "./auth/AccountAuth.ts";
import * as EmailSender from "./auth/EmailSender.ts";
import * as ApnsClient from "./agentActivity/ApnsClient.ts";
import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as FcmDeliveryQueueSender from "./agentActivity/FcmDeliveryQueueSender.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProvider.ts";
import * as HookInbox from "./hooks/HookInbox.ts";
import * as HookForwarder from "./hooks/HookForwarder.ts";
import { config } from "./test/fixtures.ts";

// Only infrastructure boundaries are stubbed; every API and relay service is real.
const bindings = Layer.mergeAll(
  Layer.succeed(RelayDb.RelayDb, {
    $client: { withTransaction: (effect) => effect },
  } as RelayDb.RelayDb["Service"]),
  RelayConfiguration.layer(config),
  NodeCrypto.layer,
  EmailSender.layerDisabled,
  ApnsClient.layerDisabled,
  Layer.succeed(AccountAuth.SignInRateLimiter, {
    allowStart: () => Effect.succeed(true),
    allowVerify: () => Effect.succeed(true),
  }),
  Layer.succeed(HookForwarder.HookRateLimiter, {
    allowHook: () => Effect.succeed(true),
    allowEndpoint: () => Effect.succeed(true),
  }),
  Layer.mock(ManagedEndpointProvider.ManagedEndpointTunnelClient, {}),
  Layer.mock(ManagedEndpointProvider.ManagedEndpointDnsClient, {}),
  Layer.mock(HookInbox.HookInbox, {}),
  Layer.mock(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {}),
  Layer.mock(FcmDeliveryQueueSender.FcmDeliveryQueueSender, {}),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("Unexpected network request")),
  ),
);

describe("Worker HTTP composition", () => {
  it.live("builds every deployed API group with the production relay service layers", () =>
    Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(RelayApi).pipe(
            Layer.provide(
              Runtime.makeAppLayer(Runtime.layerServices.pipe(Layer.provideMerge(bindings))),
            ),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (app) => Effect.promise(() => app.dispose()),
    ).pipe(
      Effect.flatMap((app) =>
        Effect.promise(async () => {
          const response = await app.handler(
            new Request(`${config.relayIssuer}/.well-known/oauth-authorization-server`),
          );
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ issuer: config.relayIssuer });
        }),
      ),
      Effect.scoped,
    ),
  );
});
