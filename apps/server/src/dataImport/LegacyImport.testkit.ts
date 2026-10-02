import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerConfig } from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const projects = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* ProjectStore.ProjectStoreV2;
    const convert = (row: ProjectStore.ProjectRow) => ({
      ...row,
      id: row.projectId,
      repositoryIdentity: null,
      additionalInstructions: row.additionalInstructions ?? null,
    });
    return Layer.mock(ProjectService.ProjectService)({
      getById: (id) => store.get(id).pipe(Effect.map(Option.map(convert)), Effect.orDie),
      getByWorkspaceRoot: (root) =>
        store.list().pipe(
          Effect.map((rows) =>
            Option.map(
              Option.fromNullishOr(rows.find((row) => row.workspaceRoot === root)),
              convert,
            ),
          ),
          Effect.orDie,
        ),
    });
  }),
).pipe(Layer.provide(stores));
export const importLayer = Layer.mergeAll(
  EventSink.layer,
  ProjectionMaintenance.layer,
  projects,
  serverSettingsLayerTest(),
).pipe(
  Layer.provideMerge(stores),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "import-v2-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
