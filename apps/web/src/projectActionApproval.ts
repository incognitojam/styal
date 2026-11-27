import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, ProjectScript } from "@t3tools/contracts";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { projectActions } from "./state/projectActions";
import { requestWorktreeLayoutApproval } from "./worktreeLayoutApproval";

export async function approveProjectAction(input: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectTitle: string;
  action: ProjectScript;
  setup?: boolean;
  review?: boolean;
}) {
  const result = await runAtomCommand(
    appAtomRegistry,
    projectActions.read,
    {
      environmentId: input.environmentId,
      input: { projectId: input.projectId },
    },
    { reportFailure: false },
  );
  // Unreadable setup reaches the runner, which records the reason without running a command.
  if (result._tag !== "Success") return input.setup === true;
  if (!result.value.policyAllowed) return false;
  const action = result.value.actions.find(
    (entry) => entry.id === input.action.id && entry.command === input.action.command,
  );
  if (!action) return false;
  if (action.approved) return true;
  if (!appAtomRegistry.get(projectActions.setApproval.permissionAtom(input.environmentId)))
    return false;
  if (
    !(await requestWorktreeLayoutApproval({
      projectTitle: input.projectTitle,
      commands: [{ kind: "action", command: action.command, name: action.name }],
      mode: input.review ? "review" : input.setup ? "setup" : "action",
    }))
  )
    return false;
  const saved = await runAtomCommand(appAtomRegistry, projectActions.setApproval, {
    environmentId: input.environmentId,
    input: { projectId: input.projectId, command: action.command, approved: true },
  });
  return saved._tag === "Success";
}

export async function approveSetupAction(input: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectTitle: string;
}) {
  const result = await runAtomCommand(
    appAtomRegistry,
    projectActions.read,
    {
      environmentId: input.environmentId,
      input: { projectId: input.projectId },
    },
    { reportFailure: false },
  );
  if (result._tag !== "Success") return true;
  const action = result.value.actions.find((entry) => entry.runOnWorktreeCreate);
  return !action || approveProjectAction({ ...input, action, setup: true });
}
