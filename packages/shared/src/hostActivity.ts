import type {
  ConfirmDialogThreadActivity,
  DesktopUpdateActivity,
  HostActivity,
  HostActivityThread,
} from "@t3tools/contracts";

export type HostActivityCheck = HostActivity & {
  readonly hostLabel?: string;
  readonly continueRunningThreads?: boolean;
};

/** Replace only the selected environment's counts with its separately authorized details. */
export function desktopUpdateActivityChecks(
  primary: HostActivity | null,
  pool: ReadonlyArray<DesktopUpdateActivity | null> | null | undefined,
): ReadonlyArray<HostActivityCheck | null> {
  if (!pool?.length || pool.filter((entry) => entry?.isRequestingEnvironment).length !== 1) {
    // Unidentified entries may duplicate the primary. Retain known siblings and
    // readable primary details, but require consent for the incomplete coverage.
    return [
      primary && { ...primary, continueRunningThreads: true },
      ...(pool ?? []).flatMap((entry) =>
        entry && !entry.isRequestingEnvironment
          ? [
              {
                ...entry,
                hostLabel: "other environments on this desktop app",
                continueRunningThreads: true,
              },
            ]
          : [],
      ),
      null,
    ];
  }
  return [
    ...pool.map((entry) => {
      const activity = entry?.isRequestingEnvironment && primary ? primary : entry;
      return (
        activity && {
          ...activity,
          ...(entry && !entry.isRequestingEnvironment
            ? { hostLabel: "other environments on this desktop app" }
            : {}),
          continueRunningThreads: true,
        }
      );
    }),
    ...(primary === null ? [null] : []),
  ];
}

/** Short labels for the restart warning's per-thread status badges. */
export const hostActivityReasonLabels: Record<HostActivityThread["reasons"][number], string> = {
  preparing: "Preparing",
  starting: "Starting",
  running: "Running",
  input: "Needs input",
  approval: "Needs approval",
  waiting: "Waiting",
  command: "Background command",
  monitor: "Monitor",
  subagent: "Subagent",
  background_task: "Background task",
};

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export type HostActivityConcern = "running" | "waiting" | "unchecked";

/**
 * Title endings, e.g. `Quit${hostActivityQuestion.running}`. A failed check
 * asks plainly; the description says what could not be checked.
 */
export const hostActivityQuestion: Record<HostActivityConcern, string> = {
  running: " with running work?",
  waiting: " with waiting threads?",
  unchecked: "?",
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Describes the work a restart of one or more hosts would stop. A null
 * check (or an empty list) is a host whose activity could not be read, and is
 * reported with `uncheckedHostsLine`. `concern` is null when every host was
 * checked and nothing needs confirmation.
 */
export function describeHostActivity(
  checks: ReadonlyArray<HostActivityCheck | null>,
  options: {
    readonly uncheckedHostsLine: string;
    /** Thread continuation is requested, so continuable threads resume after the restart. */
    readonly continueRunningThreads?: boolean;
    /** When continuable threads resume; defaults to "after the restart". */
    readonly continuesWhen?: string;
    /** Quit copy also explains when listed threads will resume. */
    readonly includeListedThreadCounts?: boolean;
  },
): {
  readonly concern: HostActivityConcern | null;
  readonly lines: ReadonlyArray<string>;
  readonly threadActivity: ReadonlyArray<ConfirmDialogThreadActivity>;
  /** Some host or terminal could not be inspected. */
  readonly incomplete: boolean;
  /** Some work will be stopped or could not be checked; false when every affected thread continues. */
  readonly interrupts: boolean;
} {
  let active = 0;
  let continuing = 0;
  let waiting = 0;
  let unlistedInterrupted = 0;
  let unlistedContinuing = 0;
  let terminals = 0;
  let uncheckedTerminals = 0;
  let deviceUsers = 0;
  let providerInstalls = 0;
  let uncheckedHosts = checks.length === 0;
  const threadWarnings: string[] = [];
  const threadActivity: ConfirmDialogThreadActivity[] = [];
  for (const check of checks) {
    if (check === null) {
      uncheckedHosts = true;
      continue;
    }
    active += check.activeSessions;
    const continueThreads = check.continueRunningThreads ?? options.continueRunningThreads;
    if (continueThreads) continuing += check.continuableSessions;
    waiting += check.waitingSessions;
    if (!check.threads?.length || options.includeListedThreadCounts) {
      const resumes = continueThreads ? check.continuableSessions : 0;
      unlistedInterrupted += check.activeSessions - resumes + check.waitingSessions;
      unlistedContinuing += resumes;
    }
    if (check.threads === undefined && check.activeSessions + check.waitingSessions > 0) {
      threadWarnings.push(
        `Thread names and activity reasons are unavailable${check.hostLabel ? ` for ${singleLine(check.hostLabel)}` : " from this server"}.`,
      );
    }
    for (const thread of check.threads ?? []) {
      threadActivity.push({
        thread,
        ...(check.environmentId ? { environmentId: check.environmentId } : {}),
        hostLabel: check.hostLabel ?? null,
        continuesAfterRestart: Boolean(continueThreads && thread.continuable),
      });
    }
    terminals += check.terminalsRequiringConfirmation - check.terminalsWithUnknownActivity;
    uncheckedTerminals += check.terminalsWithUnknownActivity;
    deviceUsers += check.environmentsUsingDevices;
    providerInstalls += check.providerInstalls ?? 0;
  }
  const lines: string[] = [];
  const interrupted = [
    ...(unlistedInterrupted ? [plural(unlistedInterrupted, "thread")] : []),
    ...(terminals ? [plural(terminals, "terminal session")] : []),
  ];
  if (interrupted.length) lines.push(`${interrupted.join(" and ")} will be interrupted.`);
  if (unlistedContinuing)
    lines.push(
      `${plural(unlistedContinuing, "thread")} will continue ${options.continuesWhen ?? "after the restart"}.`,
    );
  if (deviceUsers) lines.push("Devices in use by other environments will be disconnected.");
  if (providerInstalls)
    lines.push(
      `${providerInstalls === 1 ? "A provider update is" : `${providerInstalls} provider updates are`} installing and will be interrupted.`,
    );
  if (uncheckedTerminals)
    lines.push(
      `Could not check ${plural(uncheckedTerminals, "terminal session")} for running commands.`,
    );
  if (uncheckedHosts) lines.push(options.uncheckedHostsLine);
  // Hosts without a label, and anonymous desktop siblings, produce identical warnings.
  if (threadWarnings.length) lines.push("", ...new Set(threadWarnings));
  return {
    concern:
      active || terminals || deviceUsers || providerInstalls
        ? "running"
        : waiting
          ? "waiting"
          : lines.length
            ? "unchecked"
            : null,
    lines,
    threadActivity,
    incomplete: uncheckedHosts || uncheckedTerminals > 0,
    interrupts:
      active - continuing + waiting > 0 ||
      terminals > 0 ||
      deviceUsers > 0 ||
      providerInstalls > 0 ||
      uncheckedHosts ||
      uncheckedTerminals > 0,
  };
}

/**
 * Every host must have been checked. Providers cannot restore waiting sessions after a restart,
 * so they block, as do turns continuation will not resume, provider installs, and shared devices.
 * Turns that will resume and terminal commands do not block.
 */
export function idleRestartBlocked(checks: ReadonlyArray<HostActivityCheck | null>): boolean {
  if (checks.length === 0) return true;
  return checks.some(
    (check) =>
      check === null ||
      check.waitingSessions > 0 ||
      check.activeSessions > check.continuableSessions ||
      (check.providerInstalls ?? 0) > 0 ||
      check.environmentsUsingDevices > 0,
  );
}

type Reason = HostActivityThread["reasons"][number];

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
  environmentId: ConfirmDialogThreadActivity["environmentId"];
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
      host = {
        key: hostKey,
        environmentId: item.environmentId,
        label: item.hostLabel,
        sections: [],
      };
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
