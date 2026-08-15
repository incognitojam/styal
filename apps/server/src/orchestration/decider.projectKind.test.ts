import { CommandId, ProjectId, resolveProjectKind } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-kind");

it.layer(NodeServices.layer)("decider project kind", (it) => {
  it.effect("carries kind through project.create into the read model", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-project-kind-create"),
          projectId,
          title: "Scratchpad",
          workspaceRoot: "/tmp/project-kind",
          kind: "workspace",
          createdAt: now,
        },
        readModel: createEmptyReadModel(now),
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.created");
      expect((event.payload as { kind?: unknown }).kind).toBe("workspace");

      const readModel = yield* projectEvent(createEmptyReadModel(now), {
        ...event,
        sequence: 1,
      });
      expect(readModel.projects[0]?.kind).toBe("workspace");
    }),
  );

  it.effect("omits kind when absent so back-compat projects resolve to repository", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-project-kind-legacy"),
          projectId,
          title: "Repo",
          workspaceRoot: "/tmp/project-kind-legacy",
          createdAt: now,
        },
        readModel: createEmptyReadModel(now),
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect((event.payload as { kind?: unknown }).kind).toBeUndefined();

      const readModel = yield* projectEvent(createEmptyReadModel(now), {
        ...event,
        sequence: 1,
      });
      const project = readModel.projects[0];
      expect(project?.kind).toBeUndefined();
      expect(project && resolveProjectKind(project)).toBe("repository");
    }),
  );

  it.effect("flips kind back to repository through project.meta.update", () =>
    Effect.gen(function* () {
      const created = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-project-kind-create"),
          projectId,
          title: "Scratchpad",
          workspaceRoot: "/tmp/project-kind",
          kind: "workspace",
          createdAt: now,
        },
        readModel: createEmptyReadModel(now),
      });
      const createdEvent = Array.isArray(created) ? created[0] : created;
      const readModel = yield* projectEvent(createEmptyReadModel(now), {
        ...createdEvent,
        sequence: 1,
      });

      const unrelated = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-kind-title"),
          projectId,
          title: "Renamed",
        },
        readModel,
      });
      const unrelatedEvent = Array.isArray(unrelated) ? unrelated[0] : unrelated;
      expect("kind" in (unrelatedEvent.payload as object)).toBe(false);
      const afterRename = yield* projectEvent(readModel, {
        ...unrelatedEvent,
        sequence: 2,
      });
      expect(afterRename.projects[0]?.kind).toBe("workspace");

      const flipped = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-kind-flip"),
          projectId,
          kind: "repository",
        },
        readModel: afterRename,
      });
      const flippedEvent = Array.isArray(flipped) ? flipped[0] : flipped;
      expect(flippedEvent.type).toBe("project.meta-updated");
      expect((flippedEvent.payload as { kind?: unknown }).kind).toBe("repository");

      const afterFlip = yield* projectEvent(afterRename, {
        ...flippedEvent,
        sequence: 3,
      });
      expect(afterFlip.projects[0]?.kind).toBe("repository");
    }),
  );
});
