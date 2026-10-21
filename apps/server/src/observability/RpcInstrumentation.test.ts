import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  ScheduledTaskError,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { RpcInstrumentation, rpcInstrumentationLayer } from "./RpcInstrumentation.ts";

type WsRpcMethod = keyof typeof RPC_REQUIRED_SCOPES;

const groupOf = <const Tags extends ReadonlyArray<WsRpcMethod>>(...tags: Tags) =>
  WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<WsRpcMethod, Tags[number]> =>
        !(tags as ReadonlyArray<string>).includes(tag),
    ),
  ).middleware(RpcInstrumentation);

const connectionMiddleware = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Layer.merge(RpcAuthorization.layer(scopes), rpcInstrumentationLayer);
const readOnlyConnection = connectionMiddleware([AuthOrchestrationReadScope]);

describe("WS RPC instrumentation middleware", () => {
  it.effect("logs handler defects as errors, but not expected failures", () =>
    Effect.gen(function* () {
      const logged: Array<{ readonly level: string; readonly defects: number }> = [];
      const logger = Logger.make(({ logLevel, cause }) => {
        logged.push({
          level: logLevel,
          defects: cause.reasons.filter((reason) => reason._tag === "Die").length,
        });
      });

      const group = groupOf(
        WS_METHODS.scheduledTasksList,
        WS_METHODS.serverGetSettings,
        WS_METHODS.pullRequestsSubscribeRefreshes,
      );
      yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.scheduledTasksList, () =>
                Effect.fail(new ScheduledTaskError({ message: "List failed." })),
              ),
              group.toLayerHandler(WS_METHODS.serverGetSettings, () => Effect.die("bug")),
              group.toLayerHandler(WS_METHODS.pullRequestsSubscribeRefreshes, () =>
                Stream.die("stream bug"),
              ),
              readOnlyConnection,
            ),
          ),
        );
        yield* Effect.exit(client[WS_METHODS.scheduledTasksList]({}));
        yield* Effect.exit(client[WS_METHODS.serverGetSettings]({}));
        yield* Effect.exit(Stream.runDrain(client[WS_METHODS.pullRequestsSubscribeRefreshes]({})));
      }).pipe(Effect.scoped, Effect.provide(Logger.layer([logger])));

      assert.deepStrictEqual(logged, [
        { level: "Error", defects: 1 },
        { level: "Error", defects: 1 },
      ]);
    }),
  );
});
