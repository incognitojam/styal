import { OrchestrationV2ShellSnapshotJson } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as ServerConfig from "../config.ts";
import { expandHomePath } from "../os-jank.ts";
import { OrchestrationV2EventSinkLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import { SERVICE_LAUNCHER_CONTEXT_ENV } from "../cloud/serviceProtocol.ts";
import { DriveMode, DriveScenario, applyDriveScenario } from "../driveMode.ts";
export { DriveScenario } from "../driveMode.ts";
import { runServer } from "../server.ts";
import { resolveServerConfig, sharedServerCommandFlags, resolveCliAuthConfig } from "./config.ts";

const decodeScenarioFile = Schema.decodeUnknownEffect(Schema.fromJsonString(DriveScenario));
const decodeScenario = Schema.decodeUnknownEffect(DriveScenario);

const encodeScenario = Schema.encodeEffect(fromJsonStringPretty(DriveScenario));
const encodeScenarioSummary = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      homeDir: Schema.String,
      eventCount: Schema.Int,
      snapshot: OrchestrationV2ShellSnapshotJson,
    }),
  ),
);

class DriveScenarioError extends Schema.TaggedError<DriveScenarioError>()("DriveScenarioError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const scenarioRuntimeLayer = Layer.mergeAll(
  OrchestrationV2EventSinkLayerLive,
  ProjectionStore.layer,
  ProjectStore.layer,
).pipe(Layer.provideMerge(SqlitePersistenceLayerLive));

const prepareScenario = Effect.fn("drive.prepareScenario")(function* (
  file: string,
  destination: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scenario = yield* decodeScenarioFile(yield* fs.readFileString(file));
  const ids = new Set<string>();
  for (const command of scenario.events) {
    if (ids.has(command.id)) {
      return yield* new DriveScenarioError({
        message: `Duplicate event id '${command.id}' would silently skip a command.`,
      });
    }
    ids.add(command.id);
  }
  const homeDir = path.resolve(yield* expandHomePath(destination));
  yield* fs.makeDirectory(path.dirname(homeDir), { recursive: true });
  // Nonrecursive mkdir is the claim: even an empty existing directory or symlink is refused.
  yield* fs.makeDirectory(homeDir).pipe(
    Effect.mapError(
      (cause) =>
        new DriveScenarioError({
          message: `Cannot create '${homeDir}'. Scenario homes must not already exist.`,
          cause,
        }),
    ),
  );

  return { scenario, homeDir };
});

export const driveScenarioCommand = Command.make("scenario", {
  file: Argument.String("file").pipe(Argument.withDescription("Version 2 scenario JSON file.")),
  homeDir: Flag.String("home-dir").pipe(
    Flag.withDescription("New, nonexistent T3 home to populate. Existing paths are refused."),
  ),
}).pipe(
  Command.withDescription(
    "Create isolated synthetic state through the event engine, without providers.",
  ),
  Command.withHandler(
    Effect.fn("driveScenario")(function* (flags) {
      const { scenario, homeDir } = yield* prepareScenario(flags.file, flags.homeDir);
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig({ baseDir: Option.some(homeDir) }, logLevel);
      const snapshot = yield* Effect.gen(function* () {
        yield* applyDriveScenario(scenario);
        const query = yield* ProjectionStore.ProjectionStoreV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const threads = yield* query.getShellSnapshot();
        return {
          schemaVersion: threads.schemaVersion,
          snapshotSequence: threads.snapshotSequence,
          projects: yield* projects.listShells(),
          threads: threads.threads,
          archivedThreads: threads.archivedThreads,
        };
      }).pipe(Effect.provide(scenarioRuntimeLayer.pipe(Layer.provide(ServerConfig.layer(config)))));
      yield* Console.log(
        yield* encodeScenarioSummary({ homeDir, eventCount: scenario.events.length, snapshot }),
      );
    }),
  ),
);

export const driveServeCommand = Command.make("serve", {
  file: Argument.String("file"),
  homeDir: Flag.String("home-dir").pipe(
    Flag.withDescription("New, nonexistent home for the demo server."),
  ),
  port: sharedServerCommandFlags.port,
  host: sharedServerCommandFlags.host,
  devUrl: sharedServerCommandFlags.devUrl,
}).pipe(
  Command.withDescription(
    "Serve a scenario in the real client with provider reactors disabled. Uses a new home.",
  ),
  Command.withHandler(
    Effect.fn("drive.serve")(function* (flags) {
      const { scenario, homeDir } = yield* prepareScenario(flags.file, flags.homeDir);
      const config = yield* resolveServerConfig(
        {
          baseDir: Option.some(homeDir),
          port: flags.port,
          host: flags.host,
          devUrl: flags.devUrl,
          mode: Option.some("web"),
          cwd: Option.none(),
          noBrowser: Option.some(true),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.some(false),
          logWebSocketEvents: Option.some(false),
          tailscaleServeEnabled: Option.some(false),
          tailscaleServePort: Option.none(),
        },
        yield* GlobalFlag.LogLevel,
        { startupPresentation: "headless", forceAutoBootstrapProjectFromCwd: false },
      );
      yield* Console.error(
        "Drive demo: provider reactors are disabled. Use a normal server to verify real provider interactions.",
      );
      const environment = yield* HostProcessEnvironment;
      return yield* runServer.pipe(
        Effect.provideService(HostProcessEnvironment, {
          ...environment,
          [SERVICE_LAUNCHER_CONTEXT_ENV]: undefined,
          T3_BOOT_SERVICE_UNIT: undefined,
        }),
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provideService(DriveMode, scenario),
      );
    }),
  ),
);

export const driveExampleCommand = Command.make("example", {
  workspace: Flag.String("workspace").pipe(
    Flag.withDescription("Existing project workspace path to reference in the example."),
  ),
}).pipe(
  Command.withDescription(
    "Print an editable scenario covering empty, completed, streaming, error, and archived threads.",
  ),
  Command.withHandler(
    Effect.fn("driveExample")(function* (flags) {
      const path = yield* Path.Path;
      const now = yield* DateTime.now;
      const createdAt = DateTime.formatIso(now);
      const completedAt = DateTime.formatIso(DateTime.add(now, { milliseconds: 1 }));
      const projectId = "drive-project";
      const projects = [
        {
          projectId,
          title: "Drive scenarios",
          workspaceRoot: path.resolve(yield* expandHomePath(flags.workspace)),
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      ];
      const events: unknown[] = [];
      for (const state of ["empty", "completed", "streaming", "error", "archived"] as const) {
        const threadId = `drive-${state}`;
        const runId = `${threadId}-run`;
        const thread = {
          id: threadId,
          projectId,
          title: `Drive: ${state}`,
          createdBy: "system",
          creationSource: "server",
          providerInstanceId: "codex",
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          historyOrigin: "native",
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt,
          updatedAt: createdAt,
          archivedAt: state === "archived" ? createdAt : null,
          settledOverride: null,
          settledAt: null,
          deletedAt: null,
        };
        events.push({
          id: `${threadId}-create`,
          type: "thread.created",
          threadId,
          occurredAt: createdAt,
          payload: thread,
        });
        if (state === "empty") continue;
        events.push({
          id: `${threadId}-run-event`,
          type: "run.created",
          threadId,
          runId,
          occurredAt: createdAt,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: "codex",
            modelSelection: thread.modelSelection,
            providerThreadId: null,
            userMessageId: `${threadId}-user`,
            rootNodeId: null,
            activeAttemptId: null,
            status: state === "streaming" ? "running" : state === "error" ? "failed" : "completed",
            requestedAt: createdAt,
            startedAt: createdAt,
            completedAt: state === "streaming" ? null : completedAt,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        for (const role of ["user", "assistant"] as const) {
          const messageId = `${threadId}-${role}`;
          const streaming = role === "assistant" && state === "streaming";
          const text =
            role === "user"
              ? "Show the verification results."
              : state === "error"
                ? "Synthetic provider failure for verification."
                : streaming
                  ? "Synthetic partial response, preserved for inspecting the streaming state…"
                  : "## Verification\n\nThis is synthetic scenario content.\n\n- [x] Completed state\n- [x] Markdown rendering";
          const common = { threadId, runId, nodeId: null, text, createdAt, updatedAt: completedAt };
          events.push({
            id: `${messageId}-event`,
            type: "message.updated",
            threadId,
            runId,
            occurredAt: completedAt,
            payload: {
              ...common,
              id: messageId,
              role,
              attachments: [],
              streaming,
              createdBy: role === "user" ? "user" : "agent",
              creationSource: "server",
            },
          });
          events.push({
            id: `${messageId}-item-event`,
            type: "turn-item.updated",
            threadId,
            runId,
            occurredAt: completedAt,
            payload: {
              ...common,
              id: `${messageId}-item`,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: role === "user" ? 1 : 2,
              status: streaming ? "running" : "completed",
              title: null,
              startedAt: createdAt,
              completedAt: streaming ? null : completedAt,
              messageId,
              ...(role === "user"
                ? {
                    type: "user_message",
                    inputIntent: "turn_start",
                    attachments: [],
                    createdBy: "user",
                    creationSource: "server",
                  }
                : { type: "assistant_message", streaming }),
            },
          });
        }
      }
      const scenario = yield* decodeScenario({ version: 2, projects, events });
      yield* Console.log(yield* encodeScenario(scenario));
    }),
  ),
);
