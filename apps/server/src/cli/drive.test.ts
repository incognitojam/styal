// @effect-diagnostics nodeBuiltinImport:off -- CLI fixtures use isolated filesystem state.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  ThreadId,
  OrchestrationV2ShellSnapshotJson,
  OrchestrationV2ThreadProjectionJson,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { vi } from "vite-plus/test";
import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import * as Startup from "../serverRuntimeStartup.ts";
import * as Sqlite from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { orchestrationHttpApiLayer } from "../orchestration-v2/http.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSchemaDocument = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ $schema: Schema.String })),
);
const decodeShell = Schema.decodeSync(Schema.fromJsonString(OrchestrationV2ShellSnapshotJson));
const decodeSummary = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ snapshot: OrchestrationV2ShellSnapshotJson })),
);
const decodeThread = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ projection: OrchestrationV2ThreadProjectionJson })),
);
const decodeReceipt = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      sequence: Schema.Number,
      commandId: Schema.optional(Schema.String),
      messageId: Schema.optional(Schema.String),
    }),
  ),
);

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NetService.layer,
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { T3_DRIVE_TOKEN: "synthetic-drive-token" } }),
        ),
      ),
    ),
  );
const capture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* effect;
    return (
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      ""
    );
  }).pipe(Effect.provide(TestConsole.layer));
const scratch = Effect.acquireRelease(
  Effect.sync(() => {
    const root = NodePath.resolve(import.meta.dirname, "../../../../.scratch");
    NodeFS.mkdirSync(root, { recursive: true });
    return NodeFS.mkdtempSync(NodePath.join(root, "upstream-v2-drive-cli-"));
  }),
  (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
);
const makeScenario = (root: string) =>
  Effect.gen(function* () {
    const scenarioFile = NodePath.join(root, "scenario.json");
    const home = NodePath.join(root, "scenario-home");
    const example = yield* capture(runCli(["drive", "example", "--workspace", root]));
    NodeFS.writeFileSync(scenarioFile, example);
    const summary = yield* capture(runCli(["drive", "scenario", scenarioFile, "--home-dir", home]));
    return { home, scenarioFile, example, summary };
  });
const persistence = (home: string) =>
  Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer, OrchestrationEventStoreLive).pipe(
    Layer.provideMerge(Sqlite.layerConfig),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), home)),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect(
  "prints V2 schemas and rejects server-only events before connecting or creating state",
  () =>
    Effect.gen(function* () {
      const root = yield* scratch;
      const schema = yield* capture(runCli(["drive", "schema"]));
      const scenario = yield* capture(runCli(["drive", "schema", "--scenario"]));
      expect(decodeSchemaDocument(schema).$schema).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
      expect(schema).toContain("message.dispatch");
      expect(schema).not.toContain('"message.updated"');
      expect(scenario).toContain("message.updated");
      const file = NodePath.join(root, "command.json");
      const home = NodePath.join(root, "missing-home");
      NodeFS.writeFileSync(file, encodeJson({ type: "message.updated", id: "synthetic-event" }));
      const error = yield* runCli(["drive", "dispatch", file, "--home-dir", home]).pipe(
        Effect.flip,
      );
      expect(Schema.isSchemaError(error)).toBe(true);
      expect(NodeFS.existsSync(home)).toBe(false);
    }).pipe(Effect.scoped),
);

it.effect(
  "claims only new scenario homes and persists completed, streaming, failed, and archived V2 state",
  () =>
    Effect.gen(function* () {
      const root = yield* scratch;
      const file = NodePath.join(root, "invalid.json");
      const missingHome = NodePath.join(root, "invalid-home");
      NodeFS.writeFileSync(
        file,
        encodeJson({ version: 2, projects: [], events: [{ type: "invalid" }] }),
      );
      yield* runCli(["drive", "scenario", file, "--home-dir", missingHome]).pipe(Effect.flip);
      expect(NodeFS.existsSync(missingHome)).toBe(false);
      const fixture = yield* makeScenario(root);
      const marker = NodePath.join(fixture.home, "keep.txt");
      NodeFS.writeFileSync(marker, "existing state");
      const error = yield* runCli([
        "drive",
        "scenario",
        fixture.scenarioFile,
        "--home-dir",
        fixture.home,
      ]).pipe(Effect.flip);
      expect(String(error)).toContain("Scenario homes must not already exist");
      expect(NodeFS.readFileSync(marker, "utf8")).toBe("existing state");
      const summary = decodeSummary(fixture.summary);
      expect(summary.snapshot.projects[0]?.title).toBe("Drive scenarios");
      expect(summary.snapshot.threads).toHaveLength(4);
      expect(summary.snapshot.archivedThreads).toHaveLength(1);
      yield* Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const completed = yield* store.getThreadSnapshot(ThreadId.make("drive-completed"));
        expect(completed.projection.messages.map((message) => message.role)).toEqual([
          "user",
          "assistant",
        ]);
        expect(completed.projection.messages[1]?.text).toContain("Verification");
        expect(completed.projection.runs[0]?.status).toBe("completed");
        const sql = yield* SqlClient.SqlClient;
        const userAt = "2026-09-10T10:00:00.000Z";
        const assistantAt = "2026-09-10T10:02:00.000Z";
        yield* sql`UPDATE orchestration_v2_projection_messages SET updated_at = ${userAt} WHERE thread_id = 'drive-completed' AND role = 'user'`;
        yield* sql`UPDATE orchestration_v2_projection_messages SET updated_at = ${assistantAt} WHERE thread_id = 'drive-completed' AND role = 'assistant'`;
        const shell = yield* store.getThreadShell(ThreadId.make("drive-completed"));
        expect(shell?.latestMessageAt && DateTime.formatIso(shell.latestMessageAt)).toBe(
          assistantAt,
        );
        expect(shell?.latestUserMessageAt && DateTime.formatIso(shell.latestUserMessageAt)).toBe(
          userAt,
        );
        yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE thread_id = 'drive-completed' AND role = 'assistant'`;
        const afterRevert = yield* store.getThreadShell(ThreadId.make("drive-completed"));
        expect(
          afterRevert?.latestMessageAt && DateTime.formatIso(afterRevert.latestMessageAt),
        ).toBe(userAt);
        const streaming = yield* store.getThreadSnapshot(ThreadId.make("drive-streaming"));
        expect(streaming.projection.runs[0]?.status).toBe("running");
        expect(streaming.projection.messages[1]).toMatchObject({
          streaming: true,
          text: expect.stringContaining("partial response"),
        });
        const failed = yield* store.getThreadSnapshot(ThreadId.make("drive-error"));
        expect(failed.projection.runs[0]?.status).toBe("failed");
        const archived = yield* store.getThreadSnapshot(ThreadId.make("drive-archived"));
        expect(archived.projection.thread?.archivedAt).not.toBeNull();
      }).pipe(Effect.provide(persistence(fixture.home)));
    }).pipe(Effect.scoped),
);

class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.orchestration) {}
it.effect(
  "drives canonical HTTP snapshots and sends with the current model while enforcing write scope",
  () =>
    Effect.gen(function* () {
      const root = yield* scratch;
      const fixture = yield* makeScenario(root);
      const dispatched: OrchestrationV2ServerCommand[] = [];
      const requests: Request[] = [];
      let operate = false;
      const routes = HttpApiBuilder.layer(TestApi).pipe(
        Layer.provide(orchestrationHttpApiLayer),
        Layer.provide(
          Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
            Effect.suspend(() =>
              effect.pipe(
                Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                  sessionId: AuthSessionId.make("synthetic-drive-session"),
                  subject: "synthetic-drive",
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
        ),
        Layer.provide(
          Layer.mock(Startup.ServerRuntimeStartup)({ enqueueCommand: (effect) => effect }),
        ),
        Layer.provide(
          Layer.unwrap(
            Effect.gen(function* () {
              const store = yield* ProjectionStore.ProjectionStoreV2;
              return Layer.mock(ThreadManagement.ThreadManagementService)({
                getShellSnapshot: (options) => store.getShellSnapshot(options).pipe(Effect.orDie),
                getThreadSnapshot: (id) => store.getThreadSnapshot(id).pipe(Effect.orDie),
                dispatch: (command) =>
                  Effect.sync(() => {
                    dispatched.push(command);
                    return { sequence: 77, storedEvents: [] };
                  }),
              });
            }),
          ),
        ),
        Layer.provide(
          Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({
            getAvailable: () =>
              Effect.succeed({
                repositoryIdentity: null,
                faviconPath: null,
                repositoryIdentityResolved: false,
              }),
          }),
        ),
        Layer.provide(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
        Layer.provideMerge(persistence(fixture.home)),
      );
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
        (value) => Effect.promise(() => value.dispose()),
      );
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return server.handler(request);
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => fetchMock.mockRestore()));
      const flags = ["--url", "http://synthetic-drive.invalid"];
      const shell = decodeShell(yield* capture(runCli(["drive", "snapshot", ...flags])));
      expect(shell.projects[0]?.title).toBe("Drive scenarios");
      expect(shell.threads).toHaveLength(4);
      const detail = decodeThread(
        yield* capture(runCli(["drive", "snapshot", "--thread", "drive-completed", ...flags])),
      );
      expect(detail.projection.messages[1]?.text).toContain("Verification");
      const file = NodePath.join(root, "command.json");
      NodeFS.writeFileSync(
        file,
        encodeJson({
          type: "message.dispatch",
          commandId: "synthetic-command",
          threadId: "drive-completed",
          messageId: "synthetic-queued-message",
          createdBy: "user",
          creationSource: "server",
          text: "Review [#42 Synthetic issue](t3-context://v1/issue/issue_synthetic)",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          context: {
            version: 1,
            records: [
              {
                version: 1,
                kind: "issue",
                contextId: "issue_synthetic",
                label: "#42 Synthetic issue",
                provider: "github",
                repository: "synthetic/demo",
                number: 42,
                title: "Synthetic issue",
                url: "https://github.com/synthetic/demo/issues/42",
                state: "open",
                author: null,
                body: "Exact queued issue body",
                comments: [{ author: null, body: "Exact comment" }],
              },
            ],
          },
        }),
      );
      yield* runCli(["drive", "dispatch", file, ...flags]).pipe(Effect.flip);
      expect(dispatched).toHaveLength(0);
      operate = true;
      // Build authentication per request so the same CLI connection can gain operate scope.
      const receipt = decodeReceipt(yield* capture(runCli(["drive", "dispatch", file, ...flags])));
      expect(receipt.sequence).toBe(77);
      expect(dispatched[0]).toMatchObject({
        type: "message.dispatch",
        dispatchMode: { type: "queue_after_active" },
        context: {
          records: [
            {
              kind: "issue",
              body: "Exact queued issue body",
              comments: [{ body: "Exact comment" }],
            },
          ],
        },
      });
      const sent = decodeReceipt(
        yield* capture(runCli(["drive", "send", "drive-completed", "Verify this state", ...flags])),
      );
      expect(sent).toMatchObject({
        sequence: 77,
        commandId: expect.any(String),
        messageId: expect.any(String),
      });
      expect(dispatched[1]).toMatchObject({
        type: "message.dispatch",
        threadId: "drive-completed",
        text: "Verify this state",
        messageId: sent.messageId,
        modelSelection: detail.projection.thread?.modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "server",
      });
      expect(
        requests.every(
          (request) =>
            request.headers.get("authorization") === "Bearer synthetic-drive-token" &&
            request.headers.get("x-t3-orchestration-protocol") === "2",
        ),
      ).toBe(true);
    }).pipe(Effect.scoped),
);
