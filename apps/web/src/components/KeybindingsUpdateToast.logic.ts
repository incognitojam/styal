import type { ServerConfigIssue, ServerConfigStreamEvent } from "@t3tools/contracts";

const KEYBINDINGS_SUCCESS_TOAST_COOLDOWN_MS = 2_000;

export type KeybindingsUpdateToastDecision =
  | { readonly _tag: "Success" }
  | { readonly _tag: "InvalidConfiguration"; readonly message: string };

export interface KeybindingsUpdateToastController {
  readonly handle: (event: ServerConfigStreamEvent | null) => KeybindingsUpdateToastDecision | null;
}

export function createKeybindingsUpdateToastController(input: {
  readonly now?: () => number;
  readonly isKeybindingsPage?: () => boolean;
  readonly initialIssues?: readonly ServerConfigIssue[];
}): KeybindingsUpdateToastController {
  const now = input.now ?? Date.now;
  const problemSet = (issues: readonly ServerConfigIssue[]) =>
    JSON.stringify(
      [
        ...new Set(
          issues
            .filter((issue) => issue.kind.startsWith("keybindings."))
            .map((issue) => JSON.stringify([issue.kind, issue.message])),
        ),
      ].sort(),
    );
  let previousProblems = problemSet(input.initialIssues ?? []);
  let lastSuccessToastAt: number | null = null;

  return {
    handle: (event) => {
      if (event?.type === "snapshot") {
        previousProblems = problemSet(event.config.issues);
        return null;
      }
      if (event?.type !== "keybindingsUpdated") {
        return null;
      }

      const problems = problemSet(event.payload.issues);
      const changed = problems !== previousProblems;
      previousProblems = problems;
      const issue = event.payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      if (issue) {
        if (!changed || input.isKeybindingsPage?.()) return null;
        return {
          _tag: "InvalidConfiguration",
          message: issue.message,
        };
      }

      const currentTime = now();
      if (
        lastSuccessToastAt !== null &&
        currentTime - lastSuccessToastAt < KEYBINDINGS_SUCCESS_TOAST_COOLDOWN_MS
      ) {
        return null;
      }

      lastSuccessToastAt = currentTime;
      return { _tag: "Success" };
    },
  };
}
