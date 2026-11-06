/**
 * What happens to work other machines started here when this machine allows them less.
 * The limit itself is `incomingMachineAccess`, read per request at `/mcp` and for devices.
 */
import {
  CommandId,
  type IncomingMachineAccess as IncomingMachineAccessLevel,
  type PeerIncomingWork,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DeviceSharing from "../device/DeviceSharing.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

export class IncomingMachineAccess extends Context.Service<
  IncomingMachineAccess,
  {
    readonly work: Effect.Effect<PeerIncomingWork>;
    /** Below Everything, interrupts that work and closes devices other machines hold. */
    readonly settingChanged: (level: IncomingMachineAccessLevel) => Effect.Effect<void>;
  }
>()("@styal/cli/peer/IncomingMachineAccess") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const devices = yield* DeviceSharing.DeviceSharing;

  const runningFromMachines = Effect.gen(function* () {
    const index = yield* threads.listActiveShellIndex();
    const shells = yield* Effect.forEach(
      index.filter((entry) => entry.mayBeLive),
      (entry) => threads.getThreadShell(entry.id),
    );
    return shells.flatMap((shell) =>
      shell?.linkOrigin !== undefined &&
      shell.deletedAt === null &&
      shell.archivedAt === null &&
      shell.activeRunId !== null
        ? [shell]
        : [],
    );
  });

  const stopWork = Effect.gen(function* () {
    const running = yield* runningFromMachines;
    yield* Effect.forEach(
      running,
      (shell) =>
        threads
          .interruptThread({
            projectId: shell.projectId,
            commandId: CommandId.make(`command:machine-access:${shell.activeRunId}`),
            threadId: shell.id,
            reason: "This machine stopped allowing work from other machines.",
          })
          .pipe(
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
    work: runningFromMachines.pipe(
      Effect.map((running) => ({ runningThreads: running.length })),
      Effect.orElseSucceed(() => ({ runningThreads: 0 })),
    ),
    settingChanged: Effect.fn("IncomingMachineAccess.settingChanged")(function* (level) {
      if (level !== "everything") yield* stopWork;
    }),
  });
});

export const layer = Layer.effect(IncomingMachineAccess, make);
