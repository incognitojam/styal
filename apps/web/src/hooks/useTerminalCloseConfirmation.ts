import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";
import {
  confirmTerminalClose,
  resolveTerminalCloseConfirmationIds,
  runTerminalCloseConfirmationFlow,
  type TerminalCloseTarget,
} from "~/lib/terminalCloseConfirm";
import { terminalEnvironment } from "~/state/terminal";
import { useAtomCommand } from "~/state/use-atom-command";

export function useTerminalCloseConfirmation() {
  const closePreflight = useAtomCommand(terminalEnvironment.closePreflight, {
    reportFailure: false,
  });

  return useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly targets: readonly [TerminalCloseTarget, ...TerminalCloseTarget[]];
    }): Promise<boolean> => {
      return runTerminalCloseConfirmationFlow(async () => {
        const result = await closePreflight({
          environmentId: input.environmentId,
          input: {
            threadId: input.threadId,
            terminalIds: input.targets.map(({ terminalId }) => terminalId),
          },
        });
        const confirmationTerminalIds = resolveTerminalCloseConfirmationIds(
          input.targets,
          result._tag === "Success" ? result.value.confirmationTerminalIds : null,
        );
        return confirmTerminalClose(input.targets, confirmationTerminalIds);
      });
    },
    [closePreflight],
  );
}
