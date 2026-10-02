import {
  ApplicationProjectCreatedPayload,
  CommandId,
  EventId,
  OrchestrationV2DomainEventJson,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EventSink from "./orchestration-v2/EventSink.ts";

export const DriveScenario = Schema.Struct({
  version: Schema.Literal(2),
  projects: Schema.Array(ApplicationProjectCreatedPayload),
  events: Schema.Array(OrchestrationV2DomainEventJson).check(Schema.isNonEmpty()),
});
export type DriveScenario = typeof DriveScenario.Type;

export const applyDriveScenario = Effect.fn("drive.applyScenario")(function* (
  scenario: DriveScenario,
) {
  const sink = yield* EventSink.EventSinkV2;
  for (const project of scenario.projects) {
    const commandId = CommandId.make(`drive:project:${project.projectId}`);
    yield* sink.commitProjectCommand({
      commandId,
      projectId: project.projectId,
      commandType: "project.create",
      acceptedAt: DateTime.makeUnsafe(project.createdAt),
      event: {
        eventId: EventId.make(commandId),
        type: "project.created",
        aggregateKind: "project",
        aggregateId: project.projectId,
        occurredAt: project.createdAt,
        commandId,
        causationEventId: null,
        correlationId: commandId,
        metadata: {},
        payload: project,
      },
    });
  }
  yield* sink.write({ events: scenario.events });
});

/** Supplied only by drive serve for a newly claimed, isolated scenario home. */
export class DriveMode extends Context.Reference<DriveScenario | undefined>("t3/driveMode", {
  defaultValue: () => undefined,
}) {}
