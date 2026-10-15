import type { ConfirmDialogThreadActivity } from "@t3tools/contracts";
import { hostActivityReasonLabels } from "@t3tools/shared/hostActivity";
import { CircleHelpIcon, MessageSquareIcon, RadioIcon } from "lucide-react";
import { deriveProjectIdentity } from "../projectIdentity";
import { groupHostActivityThreads, type HostActivityGroup } from "./HostActivityThreadList.logic";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProjectMonogram } from "./ProjectMonogram";

const activityIcons = {
  Running: MessageSquareIcon,
  Monitoring: RadioIcon,
  "Waiting for input or approval": CircleHelpIcon,
};

function ActivityHeading({ label }: { readonly label: HostActivityGroup }) {
  const Icon = activityIcons[label];
  return (
    <h4 className="mb-2 flex items-start gap-2 text-sm font-medium text-foreground">
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span>{label}</span>
    </h4>
  );
}

function ActivityProjectIcon({ activity }: { readonly activity: ConfirmDialogThreadActivity }) {
  const { thread, environmentId } = activity;
  if (!thread.project) return null;
  if (environmentId) {
    return <ProjectFavicon project={{ ...thread.project, environmentId }} className="size-3.5" />;
  }
  const identity = deriveProjectIdentity(thread.project.title);
  return <ProjectMonogram text={identity.monogram} color={identity.color} className="size-3.5" />;
}

export function HostActivityThreadList({
  activity,
}: {
  readonly activity: ReadonlyArray<ConfirmDialogThreadActivity>;
}) {
  const hosts = groupHostActivityThreads(activity);
  return (
    <div className="mx-6 mb-6 min-h-0 overflow-y-auto">
      <ul aria-label="Affected threads" className="space-y-6">
        {hosts.map((host) => (
          <li key={host.key}>
            {host.label ? (
              <h3 className="mb-3 wrap-anywhere text-sm font-medium text-foreground">
                {host.label}
              </h3>
            ) : null}
            <div className="space-y-5">
              {host.groups.map((group) => (
                <section aria-label={group.label} key={group.label}>
                  <ActivityHeading label={group.label} />
                  <div className="space-y-3">
                    {group.projects.map((project) => {
                      const first = project.activity[0]!;
                      const projectTitle = first.thread.project?.title;
                      return (
                        <div key={project.key}>
                          {projectTitle ? (
                            <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                              <ActivityProjectIcon activity={first} />
                              <span className="min-w-0 wrap-anywhere">{projectTitle}</span>
                            </p>
                          ) : null}
                          <ul className={projectTitle ? "space-y-2 pl-5" : "space-y-2"}>
                            {project.activity.map(({ thread, continuesAfterRestart }) => {
                              const showReasons = !(
                                thread.reasons.length === 1 &&
                                (thread.reasons[0] === "running" || thread.reasons[0] === "monitor")
                              );
                              return (
                                <li key={thread.threadId}>
                                  <p className="wrap-anywhere text-sm leading-5 text-foreground">
                                    {thread.title.trim() || "Untitled thread"}
                                  </p>
                                  {showReasons ? (
                                    <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
                                      {thread.reasons
                                        .map((reason) => hostActivityReasonLabels[reason])
                                        .join(", ")}
                                    </p>
                                  ) : null}
                                  {continuesAfterRestart ? (
                                    <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
                                      Continues after restart
                                    </p>
                                  ) : null}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
