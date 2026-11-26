import { msg, useMessages } from "gt-react";
import {
  hostActivityReasonLabels,
  hostActivitySectionHeading,
} from "@t3tools/shared/hostActivityCopy";
import type { ConfirmDialogThreadActivity } from "@t3tools/contracts";
import {
  groupHostActivityThreads,
  hostActivityReasonTone,
  hostActivityShownReasons,
} from "@t3tools/shared/hostActivity";
import { deriveProjectIdentity } from "../projectIdentity";
import { useEnvironmentMachines } from "../state/environments";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProjectMonogram } from "./ProjectMonogram";
import { Badge } from "./ui/badge";

function ActivityProjectIcon({ activity }: { readonly activity: ConfirmDialogThreadActivity }) {
  const { thread, environmentId } = activity;
  if (!thread.project) return null;
  if (environmentId) {
    return <ProjectFavicon project={{ ...thread.project, environmentId }} className="size-3.5" />;
  }
  const identity = deriveProjectIdentity(thread.project.title);
  return <ProjectMonogram text={identity.monogram} color={identity.color} className="size-3.5" />;
}

/** Affected threads under their projects, each with a badge per kind of work it has running. */
export function HostActivityThreadList({
  activity,
  withinMachine = false,
}: {
  readonly activity: ReadonlyArray<ConfirmDialogThreadActivity>;
  /** Rendered under a machine heading the caller already shows. */
  readonly withinMachine?: boolean;
}) {
  const m = useMessages();
  const machines = useEnvironmentMachines();
  const hosts = groupHostActivityThreads(activity);
  return (
    <div className={withinMachine ? "mt-3" : "mx-6 mb-6 min-h-0 overflow-y-auto"}>
      <ul aria-label={m(msg("Affected threads"))} className="space-y-6">
        {hosts.map((host) => {
          return (
            <li key={host.key}>
              {host.label && !withinMachine ? (
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                  <EnvironmentMachineIcon
                    aria-hidden
                    kind={(host.environmentId && machines.get(host.environmentId)) || "server"}
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 wrap-anywhere">{host.label}</span>
                </h3>
              ) : null}
              <div className="space-y-5">
                {host.sections.map((section) => {
                  const heading = hostActivitySectionHeading(section.continues, m);
                  return (
                    <section aria-label={heading} key={heading}>
                      <h4 className="mb-2 text-sm font-medium text-foreground">{heading}</h4>
                      <div className="space-y-3">
                        {section.projects.map((project) => {
                          const first = project.activity[0]!;
                          const projectTitle = first.thread.project?.title;
                          return (
                            <div key={project.key}>
                              {projectTitle ? (
                                <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                                  <ActivityProjectIcon activity={first} />
                                  <span className="min-w-0 wrap-anywhere">{projectTitle}</span>
                                </p>
                              ) : null}
                              <ul className={projectTitle ? "space-y-1.5 pl-5" : "space-y-1.5"}>
                                {project.activity.map(({ thread }) => (
                                  <li
                                    className="flex items-start justify-between gap-3"
                                    key={thread.threadId}
                                  >
                                    <span className="min-w-0 wrap-anywhere text-sm leading-5 text-foreground">
                                      {thread.title.trim() || m(msg("Untitled thread"))}
                                    </span>
                                    <span className="flex shrink-0 flex-wrap justify-end gap-1 pt-0.5">
                                      {hostActivityShownReasons(
                                        thread.reasons,
                                        section.continues,
                                      ).map((reason) => (
                                        <Badge
                                          key={reason}
                                          size="sm"
                                          variant={hostActivityReasonTone(reason)}
                                        >
                                          {m(hostActivityReasonLabels[reason])}
                                        </Badge>
                                      ))}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
