import type {
  ConfirmDialogThreadActivity,
  DesktopUpdateActivity,
  HostActivity,
} from "@t3tools/contracts";
import {
  desktopUpdateActivityChecks,
  describeHostActivity,
  hostActivityQuestion,
} from "@t3tools/shared/hostActivity";

export type ServerUpdateConfirmation = {
  readonly title: string;
  readonly message: string;
  readonly threadActivity: ReadonlyArray<ConfirmDialogThreadActivity>;
  readonly requiresConfirmation: boolean;
};

/**
 * Copy for confirming a server update from the environment screen. A null
 * activity is a host whose running work could not be checked.
 */
export function describeServerUpdate(input: {
  readonly serverLabel: string;
  readonly targetVersion: string;
  readonly desktopManaged: boolean;
  readonly activity: HostActivity | null;
  readonly desktopActivity?: ReadonlyArray<DesktopUpdateActivity | null> | null;
  readonly continueRunningThreads: boolean;
}): ServerUpdateConfirmation {
  const { concern, lines, incomplete, interrupts, threadActivity } = describeHostActivity(
    input.desktopManaged
      ? desktopUpdateActivityChecks(input.activity, input.desktopActivity)
      : [
          input.activity && {
            ...input.activity,
            continueRunningThreads: input.continueRunningThreads,
          },
        ],
    { uncheckedHostsLine: `Could not check ${input.serverLabel} for running work.` },
  );
  return {
    title: `Update ${input.serverLabel}${concern ? hostActivityQuestion[concern] : "?"}`,
    message: [
      `Install styal ${input.targetVersion}. ${
        input.desktopManaged
          ? "The desktop app will close and relaunch."
          : "The server will restart and reconnect."
      }`,
      ...lines,
      ...(incomplete ? ["Running threads and terminals may be interrupted."] : []),
    ].join("\n"),
    threadActivity,
    requiresConfirmation: interrupts,
  };
}

type PendingConfirmation = {
  readonly confirmation: ServerUpdateConfirmation;
  readonly resolve: (confirmed: boolean) => void;
};

const pending = new Map<string, PendingConfirmation>();
let nextId = 0;

/**
 * Presents a confirmation through `present`, which receives the request id to
 * pass to the confirmation screen. A safe preflight may proceed without granting
 * consent to interrupt work that starts before handoff.
 */
export function requestServerUpdateConfirmation(
  confirmation: ServerUpdateConfirmation,
  present: (requestId: string) => void,
): Promise<{ readonly proceed: boolean; readonly confirmed: boolean }> {
  if (!confirmation.requiresConfirmation)
    return Promise.resolve({ proceed: true, confirmed: false });
  const requestId = String(++nextId);
  return new Promise<boolean>((resolve) => {
    pending.set(requestId, { confirmation, resolve });
    present(requestId);
  }).then((confirmed) => ({ proceed: confirmed, confirmed }));
}

export function readServerUpdateConfirmation(requestId: string) {
  return pending.get(requestId)?.confirmation ?? null;
}

/** Answers a request once; later answers for the same id are ignored. */
export function respondToServerUpdateConfirmation(requestId: string, confirmed: boolean) {
  const request = pending.get(requestId);
  if (!request) return;
  pending.delete(requestId);
  request.resolve(confirmed);
}
