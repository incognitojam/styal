import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT } from "gt-react";
import { useEffect, useEffectEvent } from "react";
import { useProjectActions } from "../../hooks/useProjectActions";
import { projectActions } from "../../state/projectActions";
import { useAtomCommand } from "../../state/use-atom-command";
import { approveProjectAction } from "../../projectActionApproval";
import { ProjectActionSource } from "../ProjectActionSource";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

export function ProjectActionsSettings() {
  const gt = useGT();
  const { scope } = useSettingsScope();
  if (scope.kind !== "project" && scope.kind !== "checkout")
    return (
      <SettingsSection id="project-actions" title={gt("Actions")}>
        <SettingsRow
          title={gt("Actions belong to projects")}
          description={gt(
            "Choose a project to see actions from its default branch and commands approved on this machine.",
          )}
        />
      </SettingsSection>
    );
  return scope.members.map((member) => (
    <CheckoutActions
      key={member.physicalProjectKey}
      environmentId={member.environmentId}
      projectId={member.id}
      title={member.title}
      environmentLabel={member.environmentLabel ?? gt("Environment")}
    />
  ));
}

function CheckoutActions({
  environmentId,
  projectId,
  title,
  environmentLabel,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  title: string;
  environmentLabel: string;
}) {
  const gt = useGT();
  const query = useProjectActions(environmentId, projectId);
  const remove = useAtomCommand(projectActions.setApproval);
  const permission = useAtomValue(projectActions.setApproval.permissionAtom(environmentId));
  const fetchOnOpen = useEffectEvent(() => query.fetch());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the remote Git ref when settings opens while the cached query stays visible
  useEffect(() => {
    void fetchOnOpen();
  }, []);
  return (
    <>
      <SettingsSection id="project-actions" title={`${gt("Actions")} · ${environmentLabel}`}>
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {gt("Edit scripts in t3.json, then commit and merge them to the default branch.")}
        </p>
        {query.data && (
          <div className="px-2">
            <ProjectActionSource data={query.data} onFetch={() => void query.fetch()} />
          </div>
        )}
        {query.error && (
          <p role="alert" className="px-4 py-2 text-sm text-destructive">
            {query.error}
          </p>
        )}
        {query.data?.actions.map((action) => (
          <SettingsRow
            key={action.id}
            title={
              <span className="flex items-center gap-2">
                {action.name}
                <Badge size="sm" variant={action.approved ? "success" : "warning"}>
                  {action.approved ? gt("Approved") : gt("Needs approval")}
                </Badge>
              </span>
            }
            control={
              !action.approved && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!permission || !query.data?.policyAllowed}
                  onClick={() =>
                    void approveProjectAction({
                      environmentId,
                      projectId,
                      projectTitle: title,
                      action,
                      review: true,
                    }).then(query.refresh)
                  }
                >
                  <T>Review</T>
                </Button>
              )
            }
          >
            <pre className="overflow-auto whitespace-pre-wrap font-mono text-xs">
              {action.command}
            </pre>
          </SettingsRow>
        ))}
      </SettingsSection>
      <SettingsSection
        id="project-action-approvals"
        title={`${gt("Allowed commands")} · ${environmentLabel}`}
      >
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {gt(
            "Exact command texts approved for this project on this machine. Removing one asks for approval the next time it runs.",
          )}
        </p>
        {query.data?.approvedCommands.map((command) => (
          <SettingsRow
            key={command}
            title={<code className="whitespace-pre-wrap wrap-anywhere">{command}</code>}
            control={
              <Button
                size="xs"
                variant="ghost"
                disabled={!permission}
                onClick={() =>
                  void remove({
                    environmentId,
                    input: { projectId, command, approved: false },
                  }).then(query.refresh)
                }
              >
                <T>Remove</T>
              </Button>
            }
          />
        ))}
      </SettingsSection>
    </>
  );
}
