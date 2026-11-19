import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProjectCloneSnapshot,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { create } from "zustand";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { suggestAppAccessForRemote } from "../components/sourceControlAppAccessToast";
import { environmentProjectClonesAtom, silenceProjectCloneToasts } from "../state/projectClones";
import { projectEnvironment } from "../state/projects";
import { sourceControlEnvironment } from "../state/sourceControl";

const CLONE_LISTED_WAIT_MS = 10_000;

/** Matches the server's read cap: a larger file would arrive truncated. */
export const COPYABLE_FILE_MAX_BYTES = 1024 * 1024;

const DEFAULT_COPIED_FILE_NAME = /^(?:\.env(?:\..+)?|\.envrc|\.dev\.vars)$/;

/** Env files are the ignored files people almost always want on a new machine. */
export function isDefaultCopiedFile(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  return DEFAULT_COPIED_FILE_NAME.test(name);
}

export interface AddProjectToMachineInput {
  readonly source: { readonly environmentId: EnvironmentId; readonly cwd: string };
  /** Where the source project sits below its repository root, or "". */
  readonly subdirectory: string;
  readonly target: { readonly environmentId: EnvironmentId; readonly label: string };
  readonly projectId: ProjectId;
  readonly title: string;
  readonly remoteUrl: string;
  readonly destinationPath: string;
  readonly files: ReadonlyArray<string>;
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "An error occurred.";
}

/**
 * Resolves when the clone is listed, with "done" when it finishes, or with "settled" when it stops
 * running; null once it is removed or after `timeoutMs`. A failed or cancelled clone keeps waiting
 * for "done", since the composer offers a retry.
 */
function waitForClone(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  until: "listed" | "done" | "settled",
  timeoutMs?: number,
) {
  return new Promise<ProjectCloneSnapshot | null>((resolve) => {
    const atom = environmentProjectClonesAtom(environmentId);
    let seen = false;
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: ProjectCloneSnapshot | null) => {
      settled = true;
      unsubscribe?.();
      clearTimeout(timer);
      resolve(result);
    };
    const check = (clones: ReadonlyArray<ProjectCloneSnapshot>) => {
      if (settled) return;
      const clone = clones.find((candidate) => candidate.projectId === projectId);
      if (clone) seen = true;
      const reached =
        until === "listed" ||
        (until === "done" && clone?.phase === "done") ||
        (until === "settled" && clone?.phase !== "running");
      const result = clone && reached ? clone : !clone && seen ? null : undefined;
      if (result !== undefined) settle(result);
    };
    unsubscribe = appAtomRegistry.subscribe(atom, check);
    if (timeoutMs !== undefined) timer = setTimeout(() => settle(null), timeoutMs);
    check(appAtomRegistry.get(atom));
  });
}

export type ProjectFileCopy =
  | { readonly phase: "copying" }
  | { readonly phase: "failed"; readonly title: string; readonly failures: ReadonlyArray<string> };

/** Ignored-file copies still owed to a cloned project, keyed by its scoped project key. */
const useFileCopies = create<{ copies: Readonly<Record<string, ProjectFileCopy>> }>(() => ({
  copies: {},
}));

function setFileCopy(key: string, copy: ProjectFileCopy | null) {
  useFileCopies.setState(({ copies }) => {
    const { [key]: _previous, ...rest } = copies;
    return { copies: copy === null ? rest : { ...rest, [key]: copy } };
  });
}

/** The composer holds sends until the copy lands, and shows a failed copy until dismissed. */
export function useProjectFileCopy(ref: ScopedProjectRef | null): ProjectFileCopy | null {
  return useFileCopies((state) => (ref ? (state.copies[scopedProjectKey(ref)] ?? null) : null));
}

export function dismissProjectFileCopy(ref: ScopedProjectRef) {
  setFileCopy(scopedProjectKey(ref), null);
}

export interface PreparingAdd {
  readonly title: string;
  readonly draftId: string;
  readonly projectRef: ScopedProjectRef;
  /** Calls the add off; while the clone request is out, lets go of it. */
  readonly onCancel: () => void;
  /** The clone request is out: the row and its holds stay until it settles, dialog or not. */
  readonly sending?: boolean;
  /** Cancelled while its request was out: the row is gone, and the Add rows wait until it settles. */
  readonly cancelled?: boolean;
}

/** The one-click add being decided or sent; one at a time, so every Add row waits for it. */
export const usePreparingAddStore = create<{ add: PreparingAdd | null }>(() => ({ add: null }));

export class NoAnswerError extends Schema.TaggedError<NoAnswerError>()("NoAnswerError", {
  message: Schema.String,
}) {}

/** Counts a request of an add, or of cancelling it, as unanswered after 30 seconds. */
function within<A>(promise: Promise<A>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), 30_000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const CANCEL_SETTLE_WAIT_MS = 10_000;

/**
 * What became of an add cancelled while its clone request was out: its partial clone and project
 * were removed, it finished anyway and was kept, the machine already had the project so nothing
 * was touched, or a step failed and the project may still be there.
 */
export type CancelledAddOutcome = "removed" | "completed" | "existing" | "failed";

/**
 * Only a clone this add started and that is still running is stopped; the server deletes its
 * partial checkout, and then the project record this add created goes too. A clone that finishes
 * first is kept, so no folder is left on the other machine without a project pointing to it.
 */
export async function settleCancelledAdd(
  ref: ScopedProjectRef,
  createdByThisAdd: boolean,
): Promise<CancelledAddOutcome> {
  if (!createdByThisAdd) return "existing";
  const clone = appAtomRegistry
    .get(environmentProjectClonesAtom(ref.environmentId))
    .find((candidate) => candidate.projectId === ref.projectId);
  if (clone?.phase === "done") return "completed";
  if (clone?.phase !== "running") return "failed";
  const target = { environmentId: ref.environmentId, input: { projectId: ref.projectId } };
  const cancelling = runAtomCommand(
    appAtomRegistry,
    sourceControlEnvironment.cancelProjectClone,
    target,
    { label: "Cancel clone", reportFailure: false },
  );
  const cancelled = await within(cancelling);
  if (cancelled === "timeout" || cancelled._tag === "Failure") return "failed";
  // `applied` is also true when the clone finished while being cancelled; its phase says which.
  const settled = await waitForClone(
    ref.environmentId,
    ref.projectId,
    "settled",
    CANCEL_SETTLE_WAIT_MS,
  );
  if (settled?.phase === "done") return "completed";
  if (settled?.phase !== "cancelled") return "failed";
  const removing = runAtomCommand(appAtomRegistry, projectEnvironment.delete, target, {
    label: "Remove cancelled clone",
    reportFailure: false,
  });
  const removed = await within(removing);
  return removed !== "timeout" && removed._tag === "Success" ? "removed" : "failed";
}

export function readPreparingAdd(): PreparingAdd | null {
  return usePreparingAddStore.getState().add;
}

export function setPreparingAdd(add: PreparingAdd | null) {
  usePreparingAddStore.setState({ add });
}

export function usePreparingAdd(draftId: string | null, projectRef: ScopedProjectRef | null) {
  const projectKey = projectRef ? scopedProjectKey(projectRef) : null;
  return usePreparingAddStore(({ add }) =>
    add?.draftId === draftId && !add.cancelled && scopedProjectKey(add.projectRef) === projectKey
      ? add
      : null,
  );
}

/**
 * Clones onto another machine, then relays the chosen ignored files, since the
 * two servers never talk. Resolves with the cloning project once its clone is
 * listed; the caller opens it, and its composer shows progress, so nothing toasts.
 */
export async function addProjectToMachine(input: AddProjectToMachineInput): Promise<ProjectId> {
  // Read first, so the copy reflects the files as they were when the user asked.
  const reading = Promise.all(
    input.files.map(async (relativePath) => {
      const result = await executeAtomQuery(
        appAtomRegistry,
        projectEnvironment.readFile({
          environmentId: input.source.environmentId,
          input: { cwd: input.source.cwd, relativePath },
        }),
        { label: "Read file to copy", reportFailure: false, refresh: true },
      );
      if (result._tag === "Failure") return { relativePath, error: failureMessage(result) };
      if (result.value.truncated) return { relativePath, error: "Too large to copy." };
      return { relativePath, contents: result.value.contents };
    }),
  );
  const reads = await within(reading);
  if (reads === "timeout") throw new Error("The files to copy could not be read in time.");

  const requestedRef = { environmentId: input.target.environmentId, projectId: input.projectId };
  const requestedKey = scopedProjectKey(requestedRef);
  // Marked before the start request, since the clone list can arrive before its reply.
  silenceProjectCloneToasts(requestedRef);
  if (reads.length > 0) setFileCopy(requestedKey, { phase: "copying" });
  const starting = runAtomCommand(
    appAtomRegistry,
    sourceControlEnvironment.startProjectClone,
    {
      environmentId: input.target.environmentId,
      input: {
        projectId: input.projectId,
        title: input.title,
        createdAt: new Date().toISOString(),
        remoteUrl: input.remoteUrl,
        destinationPath: input.destinationPath,
      },
    },
    { label: "Add project to machine", reportFailure: false },
  );
  const started = await within(starting);
  if (started === "timeout" || started._tag === "Failure") {
    setFileCopy(requestedKey, null);
    if (started !== "timeout") throw new Error(failureMessage(started));
    throw new NoAnswerError({ message: `${input.target.label} did not answer.` });
  }
  // The server clones for the existing project when one already owns the empty destination.
  const { projectId } = started.value;
  const targetRef = { environmentId: input.target.environmentId, projectId };
  const copyKey = scopedProjectKey(targetRef);
  if (projectId !== input.projectId) {
    silenceProjectCloneToasts(targetRef);
    if (reads.length > 0) {
      setFileCopy(copyKey, { phase: "copying" });
      setFileCopy(requestedKey, null);
    }
  }
  void suggestAppAccessForRemote(input.target.environmentId, input.remoteUrl);
  // The clone list can arrive after the reply; a project page moves its chat draft off a
  // checkout that is neither in the project nor cloning. Bounded, since the target can drop.
  await waitForClone(input.target.environmentId, projectId, "listed", CLONE_LISTED_WAIT_MS);
  if (reads.length === 0) return projectId;

  void (async () => {
    const clone = await waitForClone(input.target.environmentId, projectId, "done");
    if (!clone) {
      setFileCopy(copyKey, null);
      return;
    }
    const failed: Array<string> = [];
    for (const read of reads) {
      if (!("contents" in read)) {
        failed.push(`${read.relativePath}: ${read.error}`);
        continue;
      }
      const written = await runAtomCommand(
        appAtomRegistry,
        projectEnvironment.writeFile,
        {
          environmentId: input.target.environmentId,
          input: {
            cwd: started.value.cwd,
            relativePath: input.subdirectory
              ? `${input.subdirectory}/${read.relativePath}`
              : read.relativePath,
            contents: read.contents,
          },
        },
        { label: "Copy file to machine", reportFailure: false },
      );
      if (written._tag === "Failure")
        failed.push(`${read.relativePath}: ${failureMessage(written)}`);
    }
    setFileCopy(
      copyKey,
      failed.length === 0
        ? null
        : {
            phase: "failed",
            title: `Could not copy ${failed.length} ${failed.length === 1 ? "file" : "files"} to ${input.target.label}`,
            failures: failed,
          },
    );
  })();
  return projectId;
}
