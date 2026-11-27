import type { EnvironmentId, ProjectId, ProjectScript } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useSyncExternalStore } from "react";
import { ScrollView, View } from "react-native";
import { useGT } from "gt-react-native";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectActions } from "../../state/projectActions";
import { Sheet } from "../../components/ui/Sheet";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

type Request = { id: number; command: string; name: string; setup: boolean; review: boolean };
let request: Request | null = null;
let resolvePending: ((value: boolean) => void) | null = null;
let nextId = 0;
const listeners = new Set<() => void>();
const publish = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) answer(request?.id, false);
  };
};
function answer(id: number | undefined, approved: boolean) {
  if (id === undefined || request?.id !== id) return;
  const resolve = resolvePending;
  resolvePending = null;
  request = null;
  publish();
  resolve?.(approved);
}

export async function approveProjectAction(input: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  action: ProjectScript;
  setup?: boolean;
  review?: boolean;
}) {
  const result = await runAtomCommand(
    appAtomRegistry,
    projectActions.read,
    { environmentId: input.environmentId, input: { projectId: input.projectId } },
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
  if (
    !listeners.size ||
    !appAtomRegistry.get(projectActions.setApproval.permissionAtom(input.environmentId))
  )
    return false;
  answer(request?.id, false);
  const approved = await new Promise<boolean>((resolve) => {
    resolvePending = resolve;
    request = {
      id: ++nextId,
      command: action.command,
      name: action.name,
      setup: input.setup ?? false,
      review: input.review ?? false,
    };
    publish();
  });
  if (!approved) return false;
  const saved = await runAtomCommand(appAtomRegistry, projectActions.setApproval, {
    environmentId: input.environmentId,
    input: { projectId: input.projectId, command: action.command, approved: true },
  });
  return saved._tag === "Success";
}

export async function approveSetupAction(input: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const result = await runAtomCommand(
    appAtomRegistry,
    projectActions.read,
    { environmentId: input.environmentId, input: { projectId: input.projectId } },
    { reportFailure: false },
  );
  if (result._tag !== "Success") return true;
  const action = result.value.actions.find((entry) => entry.runOnWorktreeCreate);
  return !action || approveProjectAction({ ...input, action, setup: true });
}

export function ProjectActionApprovalHost() {
  const gt = useGT();
  const current = useSyncExternalStore(subscribe, () => request);
  if (!current) return null;
  return (
    <Sheet
      key={current.id}
      title={current.setup ? gt("Approve worktree setup?") : gt("Approve this action?")}
      onClose={() => answer(current.id, false)}
    >
      <ScrollView contentContainerClassName="gap-5 p-5">
        <AppText>
          {gt(
            "This command text has not been approved for this project on this machine. It runs with your permissions. Approval covers the command text, not the scripts it calls.",
          )}
        </AppText>
        <AppText className="font-t3-medium">{current.name}</AppText>
        <AppText selectable className="rounded-lg bg-subtle p-4 font-mono">
          {current.command}
        </AppText>
        <View className="gap-3">
          <Button
            fullWidth
            tone="primary"
            label={current.review ? gt("Approve command") : gt("Approve and run")}
            onPress={() => answer(current.id, true)}
          />
          <Button
            fullWidth
            label={current.setup ? gt("Start without it") : gt("Cancel")}
            onPress={() => answer(current.id, false)}
          />
        </View>
      </ScrollView>
    </Sheet>
  );
}
