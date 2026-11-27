import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useEnvironmentQuery } from "../state/query";
import { projectActions } from "../state/projectActions";
import { useAtomCommand } from "../state/use-atom-command";

export function useProjectActions(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  threadId?: ThreadId,
) {
  const input = projectId ? { projectId, ...(threadId ? { threadId } : {}) } : null;
  const query = useEnvironmentQuery(input ? projectActions.list({ environmentId, input }) : null);
  const read = useAtomCommand(projectActions.read, { reportFailure: false });
  const fetch = async () => {
    if (!input) return;
    await read({ environmentId, input: { ...input, fetch: true } });
    query.refresh();
  };
  return { ...query, fetch };
}
