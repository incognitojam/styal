import type { ConfirmDialogThreadActivity } from "@t3tools/contracts";

export type HostActivityGroup = "Running" | "Monitoring" | "Waiting for input or approval";

type ProjectGroup = {
  key: string;
  activity: ConfirmDialogThreadActivity[];
};

type ActivityGroup = {
  label: HostActivityGroup;
  projects: ProjectGroup[];
};

type HostGroup = {
  key: string;
  label: string | null;
  groups: ActivityGroup[];
};

const groupOrder: ReadonlyArray<HostActivityGroup> = [
  "Running",
  "Monitoring",
  "Waiting for input or approval",
];

function activityGroup({ thread }: ConfirmDialogThreadActivity): HostActivityGroup {
  if (thread.reasons.some((reason) => ["input", "approval", "waiting"].includes(reason))) {
    return "Waiting for input or approval";
  }
  return thread.reasons.length > 0 && thread.reasons.every((reason) => reason === "monitor")
    ? "Monitoring"
    : "Running";
}

/** Each affected thread appears once, with shared project and host labels grouped together. */
export function groupHostActivityThreads(
  activity: ReadonlyArray<ConfirmDialogThreadActivity>,
): ReadonlyArray<HostGroup> {
  const hosts = new Map<string, HostGroup>();
  for (const item of activity) {
    const hostKey = item.environmentId ?? item.hostLabel ?? "";
    let host = hosts.get(hostKey);
    if (!host) {
      host = { key: hostKey, label: item.hostLabel, groups: [] };
      hosts.set(hostKey, host);
    }
    const label = activityGroup(item);
    let group = host.groups.find((candidate) => candidate.label === label);
    if (!group) {
      group = { label, projects: [] };
      host.groups.push(group);
    }
    const projectKey = item.thread.project?.id ?? item.thread.projectTitle ?? "";
    let project = group.projects.find((candidate) => candidate.key === projectKey);
    if (!project) {
      project = { key: projectKey, activity: [] };
      group.projects.push(project);
    }
    project.activity.push(item);
  }
  for (const host of hosts.values()) {
    host.groups.sort((a, b) => groupOrder.indexOf(a.label) - groupOrder.indexOf(b.label));
  }
  return [...hosts.values()];
}
