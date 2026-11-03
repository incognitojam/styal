/**
 * What happens to work other machines started here when this machine allows them less.
 * The limit itself is `incomingMachineAccess`, read per request at `/mcp` and for devices.
 */
import {
  CommandId,
  type IncomingMachineAccess as IncomingMachineAccessLevel,
  type OrchestrationV2ThreadShell,
  type PeerIncomingWork,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DeviceSharing from "../device/DeviceSharing.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

export class IncomingMachineAccess extends Context.Service<
  IncomingMachineAccess,
  {
    readonly work: Effect.Effect<PeerIncomingWork>;
    /** Below Everything, stops that work and closes devices other machines hold. */
    readonly settingChanged: (level: IncomingMachineAccessLevel) => Effect.Effect<void>;
  }
>()("@styal/cli/peer/IncomingMachineAccess") {}

/** Something that would run again on its own. A held queue waits for a person, so it isn't. */
const hasUnstoppedWork = (shell: OrchestrationV2ThreadShell) =>
  shell.activeRunId !== null ||
  (shell.pendingBackgroundTasks ?? []).length > 0 ||
  (shell.workflowRuns ?? []).length > 0 ||
  (shell.pullRequests ?? []).some((link) => link.watch !== undefined);

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const devices = yield* DeviceSharing.DeviceSharing;
  const random = yield* SecureRandom.SecureRandom;

  const workFromMachines = Effect.gen(function* () {
    const index = yield* threads.listActiveShellIndex();
    const shells = yield* Effect.forEach(
      index.filter((entry) => entry.mayBeLive),
      (entry) => threads.getThreadShell(entry.id),
    );
    return shells.flatMap((shell) =>
      shell?.linkOrigin !== undefined &&
      shell.deletedAt === null &&
      shell.archivedAt === null &&
      hasUnstoppedWork(shell)
        ? [shell]
        : [],
    );
  });

  const stopWork = Effect.gen(function* () {
    const stopping = yield* workFromMachines;
    yield* Effect.forEach(
      stopping,
      (shell) =>
        random.uuidV4().pipe(
          Effect.flatMap((uuid) =>
            // Stop, not interrupt: an interrupt starts the next queued message.
            threads.dispatch({
              type: "thread.stop",
              commandId: CommandId.make(`command:machine-access:${shell.id}:${uuid}`),
              threadId: shell.id,
              reason: "This machine stopped allowing work from other machines.",
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not stop a thread another machine started.", {
              threadId: shell.id,
              cause,
            }),
          ),
        ),
      { discard: true },
    );
    yield* devices.closePeerSessions;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not stop work other machines started.", { cause }),
    ),
  );

  return IncomingMachineAccess.of({
    work: workFromMachines.pipe(
      Effect.map((stopping) => ({ threads: stopping.length })),
      Effect.orElseSucceed(() => ({ threads: 0 })),
    ),
    settingChanged: Effect.fn("IncomingMachineAccess.settingChanged")(function* (level) {
      if (level !== "everything") yield* stopWork;
    }),
  });
});

export const layer = Layer.effect(IncomingMachineAccess, make);
