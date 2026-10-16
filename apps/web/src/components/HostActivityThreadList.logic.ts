import type { ConfirmDialogThreadActivity } from "@t3tools/contracts";

type Reason = ConfirmDialogThreadActivity["thread"]["reasons"][number];

export type HostActivityTone = "warning" | "info" | "secondary";

type ProjectGroup = {
  key: string;
  activity: ConfirmDialogThreadActivity[];
};

type Section = {
  continues: boolean;
  projects: ProjectGroup[];
};

type HostGroup = {
  key: string;
  label: string | null;
  sections: Section[];
};

/** Waiting threads need the user, turns are live work, and the rest runs in the background. */
export function hostActivityReasonTone(reason: Reason): HostActivityTone {
  if (reason === "input" || reason === "approval" || reason === "waiting") return "warning";
  if (reason === "preparing" || reason === "starting" || reason === "running") return "info";
  return "secondary";
}

/**
 * Groups affected threads by host, then by whether they are interrupted or
 * continue after the restart, then by project. Each thread appears once.
 */
export function groupHostActivityThreads(
  activity: ReadonlyArray<ConfirmDialogThreadActivity>,
): ReadonlyArray<HostGroup> {
  const hosts = new Map<string, HostGroup>();
  for (const item of activity) {
    const hostKey = item.environmentId ?? item.hostLabel ?? "";
    let host = hosts.get(hostKey);
    if (!host) {
      host = { key: hostKey, label: item.hostLabel, sections: [] };
      hosts.set(hostKey, host);
    }
    const continues = item.continuesAfterRestart;
    let section = host.sections.find((candidate) => candidate.continues === continues);
    if (!section) {
      section = { continues, projects: [] };
      host.sections.push(section);
    }
    const projectKey = item.thread.project?.id ?? "";
    let project = section.projects.find((candidate) => candidate.key === projectKey);
    if (!project) {
      project = { key: projectKey, activity: [] };
      section.projects.push(project);
    }
    project.activity.push(item);
  }
  for (const host of hosts.values()) {
    host.sections.sort((a, b) => Number(a.continues) - Number(b.continues));
  }
  return [...hosts.values()];
}
