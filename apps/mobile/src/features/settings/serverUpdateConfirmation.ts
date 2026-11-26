import { msg } from "gt-react-native";
import { m } from "../../i18n/messages";
import { describeHostActivity } from "@t3tools/shared/hostActivityCopy";
import type {
  ConfirmDialogThreadActivity,
  DesktopUpdateActivity,
  HostActivity,
} from "@t3tools/contracts";
import { desktopUpdateActivityChecks } from "@t3tools/shared/hostActivity";

export type ServerUpdateConfirmation = {
  readonly title: string;
  readonly message: string;
  readonly threadActivity: ReadonlyArray<ConfirmDialogThreadActivity>;
  readonly requiresConfirmation: boolean;
  /** Defaults to "Update". */
  readonly confirmLabel?: string;
  /** The running-work check is still going and may replace this content. */
  readonly checking?: boolean;
};

// A tap aimed at the previous content must not confirm the new content.
const CONTENT_UPDATE_TAP_GUARD_MS = 500;

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
      ? desktopUpdateActivityChecks(
          input.activity,
          input.desktopActivity,
          m(msg("other environments on this desktop app")),
        )
      : [
          input.activity && {
            ...input.activity,
            continueRunningThreads: input.continueRunningThreads,
          },
        ],
    {
      uncheckedHostsLine: m(
        msg("Could not check {server} for running work.", { server: input.serverLabel }),
      ),
    },
    m,
  );
  return {
    title: m(
      concern === "running"
        ? msg("Update {server} with running work?", { server: input.serverLabel })
        : concern === "waiting"
          ? msg("Update {server} with waiting threads?", { server: input.serverLabel })
          : msg("Update {server}?", { server: input.serverLabel }),
    ),
    message: [
      m(
        input.desktopManaged
          ? msg("Install styal {version}. The desktop app will close and relaunch.", {
              version: input.targetVersion,
            })
          : msg("Install styal {version}. The server will restart and reconnect.", {
              version: input.targetVersion,
            }),
      ),
      ...lines,
      ...(incomplete ? [m(msg("Running threads and terminals may be interrupted."))] : []),
    ].join("\n"),
    threadActivity,
    requiresConfirmation: interrupts,
  };
}

/** Asks while the running-work check is still going after its grace period. */
export function describeServerUpdateCheck(input: {
  readonly serverLabel: string;
  readonly targetVersion: string;
  readonly desktopManaged: boolean;
}): ServerUpdateConfirmation {
  return {
    title: m(msg("Update {server}?", { server: input.serverLabel })),
    message: [
      m(
        input.desktopManaged
          ? msg("Install styal {version}. The desktop app will close and relaunch.", {
              version: input.targetVersion,
            })
          : msg("Install styal {version}. The server will restart and reconnect.", {
              version: input.targetVersion,
            }),
      ),
      m(msg("Still checking {server} for running work.", { server: input.serverLabel })),
      m(msg("Updating now may interrupt running threads and terminals.")),
    ].join("\n"),
    threadActivity: [],
    requiresConfirmation: true,
    confirmLabel: m(msg("Update anyway")),
    checking: true,
  };
}

type PendingConfirmation = {
  confirmation: ServerUpdateConfirmation;
  resolve: ((confirmed: boolean) => void) | null;
  updatedAt?: number;
};

const pending = new Map<string, PendingConfirmation>();
const listeners = new Set<() => void>();
let nextId = 0;

/**
 * Presents a confirmation through `present`, which receives the request id to
 * pass to the confirmation screen. Resolves false if the screen closes without
 * an answer, and true without presenting when nothing would be interrupted.
 * `result` replaces the confirmation's content if it arrives before an answer.
 */
export function requestServerUpdateConfirmation(
  confirmation: ServerUpdateConfirmation,
  present: (requestId: string) => void,
  result?: Promise<ServerUpdateConfirmation>,
): Promise<boolean> {
  if (!confirmation.requiresConfirmation) return Promise.resolve(true);
  const requestId = String(++nextId);
  void result?.then((checked) => {
    const request = pending.get(requestId);
    if (!request?.resolve) return;
    request.confirmation = checked.requiresConfirmation
      ? checked
      : {
          ...checked,
          message: `${checked.message}\n${m(msg("Nothing running will be interrupted."))}`,
          requiresConfirmation: true,
        };
    request.updatedAt = Date.now();
    for (const listener of listeners) listener();
  });
  return new Promise((resolve) => {
    pending.set(requestId, { confirmation, resolve });
    present(requestId);
  });
}

export function subscribeServerUpdateConfirmations(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readServerUpdateConfirmation(requestId: string) {
  return pending.get(requestId)?.confirmation ?? null;
}

/** Answers a request once; later answers for the same id are ignored. */
export function respondToServerUpdateConfirmation(requestId: string, confirmed: boolean) {
  const request = pending.get(requestId);
  if (!request?.resolve) return;
  const { resolve } = request;
  request.resolve = null;
  resolve(confirmed);
}

/** Confirms unless the content changed just before the tap; returns whether it confirmed. */
export function confirmServerUpdate(requestId: string): boolean {
  const updatedAt = pending.get(requestId)?.updatedAt;
  if (updatedAt !== undefined && Date.now() - updatedAt < CONTENT_UPDATE_TAP_GUARD_MS) return false;
  respondToServerUpdateConfirmation(requestId, true);
  return true;
}

/** Answers false if still open, then drops the request once its screen is gone. */
export function releaseServerUpdateConfirmation(requestId: string) {
  respondToServerUpdateConfirmation(requestId, false);
  pending.delete(requestId);
}
