import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as ServerConfig from "../config.ts";
import * as Startup from "../serverRuntimeStartup.ts";
import { layerMemory } from "../persistence/Sqlite.ts";
import * as OrchestrationEventStoreLayer from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as OrchestrationHttp from "./http.ts";

class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.orchestration) {}

it.effect(
  "requires operate scope before enqueueing and dispatches authorized commands through startup",
  () =>
    Effect.gen(function* () {
      const dispatched: OrchestrationV2ServerCommand[] = [];
      let queued = 0;
      const makeRoutes = (operate: boolean) =>
        HttpApiBuilder.layer(TestApi).pipe(
          Layer.provide(OrchestrationHttp.layer),
          Layer.provide(
            Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
              effect.pipe(
                Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                  sessionId: AuthSessionId.make("synthetic-http-session"),
                  subject: "synthetic-test",
                  method: "browser-session-cookie",
                  scopes: new Set(
                    operate
                      ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
                      : [AuthOrchestrationReadScope],
                  ),
                }),
              ),
            ),
          ),
          Layer.provide(
            Layer.mock(Startup.ServerRuntimeStartup)({
              enqueueCommand: (effect) =>
                Effect.sync(() => {
                  queued++;
                }).pipe(Effect.andThen(effect)),
            }),
          ),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatched.push(command);
                  return { sequence: 17, storedEvents: [] };
                }),
            }),
          ),
          Layer.provide(Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({})),
          Layer.provide(ProjectStore.layer),
          Layer.provide(OrchestrationEventStoreLayer.layer),
          Layer.provide(layerMemory),
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "synthetic-http-dispatch-" }),
          ),
          Layer.provide(
            HttpPlatform.layer.pipe(
              Layer.provideMerge(NodeServices.layer),
              Layer.provideMerge(Etag.layerWeak),
            ),
          ),
          Layer.provide(NodeServices.layer),
        );
      const request = () =>
        new Request("http://127.0.0.1/api/orchestration/commands", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
          },
          body: JSON.stringify({
            type: "thread.metadata.update",
            threadId: "synthetic-http-thread",
            commandId: "synthetic-http-command",
            title: "Synthetic title",
          }),
        });
      for (const operate of [false, true]) {
        yield* Effect.acquireUseRelease(
          Effect.sync(() => HttpRouter.toWebHandler(makeRoutes(operate), { disableLogger: true })),
          (server) =>
            Effect.promise(async () => {
              const response = await server.handler(request());
              expect(response.status).toBe(operate ? 200 : 403);
              if (operate) expect(await response.json()).toEqual({ sequence: 17 });
              else expect(queued).toBe(0);
            }),
          (server) => Effect.promise(() => server.dispose()),
        );
      }
      expect(queued).toBe(1);
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.type).toBe("thread.metadata.update");
    }),
);
