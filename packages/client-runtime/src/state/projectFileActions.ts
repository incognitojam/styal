import {
  type ProjectFileActionReview,
  type ProjectFileActionRole,
  WS_METHODS,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/** Review and approval of styal.json actions that run on their own. */
export function createProjectFileActionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** What approving one action would cover, read by the server from the project root. */
    review: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:project-file-action:review",
      tag: WS_METHODS.projectsFileActionReview,
      idleTtlMs: 10_000,
    }),
    /** Approve the command the file has now, or revoke; user clients only. */
    setApproved: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-file-action:set-approved",
      tag: WS_METHODS.projectsFileActionApprovalSet,
      scheduler: createAtomCommandScheduler(),
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId }: { environmentId: string }) => environmentId,
      },
    }),
  };
}

const ROLE_PHRASES: Record<ProjectFileActionRole, string> = {
  setup: "after a worktree is created",
  settle: "when a thread settles",
};

/** "Runs after a worktree is created and when a thread settles." */
export function fileActionRolesSentence(roles: readonly ProjectFileActionRole[]): string {
  const phrases = roles.map((role) => ROLE_PHRASES[role]);
  return phrases.length === 0 ? "Runs only when you start it." : `Runs ${phrases.join(" and ")}.`;
}

/**
 * The single warning line under an approval's command: approval covers the
 * command text, not the files it runs, so later edits to those run without
 * asking again. Names the files when the server could find them.
 */
export function fileActionApprovalWarning(hint: ProjectFileActionReview["hint"]): string {
  switch (hint.kind) {
    case "files": {
      const names = hint.paths.map((path) => `\`${path}\``);
      return `Later changes to ${names.join(" and ")} run without asking again.`;
    }
    case "package-script":
      return `Later changes to the \`${hint.script}\` script in \`package.json\` run without asking again.`;
    case "none":
      return "Approves this exact command. Changes to files it runs won't ask again.";
  }
}

/** Whether the file changed the command since the user approved it. */
export function fileActionCommandChanged(review: ProjectFileActionReview): boolean {
  return review.approved !== null && review.approved.command !== review.command;
}

/** Whether the current command is approved for every role the file asks for. */
export function fileActionFullyApproved(review: ProjectFileActionReview): boolean {
  return (
    review.approved !== null &&
    review.approved.command === review.command &&
    review.roles.every((role) => review.approved?.roles.includes(role))
  );
}
