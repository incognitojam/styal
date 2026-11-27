import type { EnvironmentId, ProjectId, ProjectScript, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent } from "react";
import { View, ScrollView } from "react-native";
import { useGT } from "gt-react-native";
import { useNowMinuteMs } from "../../lib/clock";
import { projectActions } from "../../state/projectActions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { Sheet } from "../../components/ui/Sheet";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

export function ProjectActionsSheet({
  environmentId,
  projectId,
  threadId,
  onClose,
  onRun,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  onClose: () => void;
  onRun: (action: ProjectScript) => void;
}) {
  const gt = useGT();
  const now = useNowMinuteMs();
  const query = useEnvironmentQuery(
    projectActions.list({ environmentId, input: { projectId, threadId } }),
  );
  const read = useAtomCommand(projectActions.read, { reportFailure: false });
  const setApproval = useAtomCommand(projectActions.setApproval);
  const canRemove = useAtomValue(projectActions.setApproval.permissionAtom(environmentId));
  const canRun = useAtomValue(projectActions.run.permissionAtom(environmentId));
  const fetch = async () => {
    await read({ environmentId, input: { projectId, threadId, fetch: true } });
    query.refresh();
  };
  const fetchOnOpen = useEffectEvent(fetch);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the remote Git ref when the sheet opens while the cached query stays visible
  useEffect(() => {
    void fetchOnOpen();
  }, []);
  const source = query.data?.source;
  const minutes =
    source?.kind === "remote" && source.fetchedAt
      ? Math.max(0, Math.floor((now - Date.parse(source.fetchedAt)) / 60000))
      : null;
  return (
    <Sheet title={gt("Project actions")} onClose={onClose}>
      <ScrollView contentContainerClassName="gap-4 p-5">
        {source && (
          <AppText className="text-sm text-foreground-muted">
            {source.kind === "disk"
              ? gt("Actions from t3.json in this folder")
              : minutes !== null
                ? minutes === 0
                  ? gt("Actions from {ref} at {commit}, fetched just now", {
                      ref: source.ref,
                      commit: source.commit.slice(0, 7),
                    })
                  : gt("Actions from {ref} at {commit}, fetched {minutes} minutes ago", {
                      ref: source.ref,
                      commit: source.commit.slice(0, 7),
                      minutes,
                    })
                : gt("Actions from {ref} at {commit}, fetch time unknown", {
                    ref: source.ref,
                    commit: source.commit.slice(0, 7),
                  })}
          </AppText>
        )}
        {source?.kind === "remote" && (
          <Button label={gt("Fetch now")} size="compact" onPress={() => void fetch()} />
        )}
        {query.data?.unmerged && source?.kind === "remote" && (
          <View className="gap-2 rounded-lg bg-subtle p-3">
            <AppText>
              {gt(
                "This branch's t3.json has changes that aren't on {ref} yet. Actions run from {ref}.",
                { ref: source.ref },
              )}
            </AppText>
            <AppText>{query.data.changedNames.join(", ")}</AppText>
          </View>
        )}
        {query.error && <AppText accessibilityRole="alert">{query.error}</AppText>}
        {query.data && !query.data.policyAllowed && (
          <AppText>{gt("Project commands are disabled by managed policy.")}</AppText>
        )}
        {query.data?.actions.map((action) => (
          <View key={action.id} className="gap-2 rounded-lg border border-separator p-3">
            <AppText>{action.name}</AppText>
            {!action.approved && (
              <AppText className="text-warning-foreground">{gt("Needs approval")}</AppText>
            )}
            <AppText className="font-mono text-sm">{action.command}</AppText>
            <Button
              label={action.approved ? gt("Run") : gt("Review and run")}
              disabled={!canRun || !query.data?.policyAllowed}
              onPress={() => {
                onClose();
                onRun(action);
              }}
            />
          </View>
        ))}
        {query.data?.actions.length === 0 && <AppText>{gt("No actions in t3.json.")}</AppText>}
        <AppText className="font-t3-medium">{gt("Allowed commands")}</AppText>
        <AppText className="text-sm text-foreground-muted">
          {gt(
            "Exact command texts approved for this project on this machine. Removing one asks for approval the next time it runs.",
          )}
        </AppText>
        {query.data?.approvedCommands.map((command) => (
          <View key={command} className="gap-2 rounded-lg border border-separator p-3">
            <AppText selectable className="font-mono text-sm">
              {command}
            </AppText>
            <Button
              label={gt("Remove")}
              size="compact"
              disabled={!canRemove}
              onPress={() =>
                void setApproval({
                  environmentId,
                  input: { projectId, command, approved: false },
                }).then(query.refresh)
              }
            />
          </View>
        ))}
      </ScrollView>
    </Sheet>
  );
}
