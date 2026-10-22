import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ConfirmDialogThreadActivity,
  type HostActivityThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeHostActivity,
  groupHostActivityThreads,
  idleRestartBlocked,
} from "./hostActivity.ts";

const idle = {
  activeSessions: 0,
  continuableSessions: 0,
  waitingSessions: 0,
  terminalsRequiringConfirmation: 0,
  terminalsWithUnknownActivity: 0,
  environmentsUsingDevices: 0,
};
const options = { uncheckedHostsLine: "Some hosts could not be checked." };

describe("describeHostActivity", () => {
  it("needs no confirmation when every host is idle", () => {
    expect(describeHostActivity([idle, idle], options)).toEqual({
      concern: null,
      lines: [],
      incomplete: false,
      interrupts: false,
      threadActivity: [],
    });
  });

  it("adds up work across hosts", () => {
    expect(
      describeHostActivity(
        [
          { ...idle, activeSessions: 1, terminalsRequiringConfirmation: 1 },
          { ...idle, activeSessions: 1, waitingSessions: 1 },
        ],
        options,
      ),
    ).toEqual({
      concern: "running",
      lines: [
        "3 threads and 1 terminal session will be interrupted.",
        "",
        "Thread names and activity reasons are unavailable from this server.",
        "Thread names and activity reasons are unavailable from this server.",
      ],
      incomplete: false,
      interrupts: true,
      threadActivity: [],
    });
  });

  it("does not report interruption when every active thread continues", () => {
    const result = describeHostActivity(
      [{ ...idle, activeSessions: 1, continuableSessions: 1, threads: [] }],
      { ...options, continueRunningThreads: true, continuesWhen: "when styal next starts" },
    );
    expect(result.lines).toEqual(["1 thread will continue when styal next starts."]);
    expect(result.interrupts).toBe(false);
  });

  it("reports waiting threads as their own concern", () => {
    expect(describeHostActivity([{ ...idle, waitingSessions: 2 }], options).concern).toBe(
      "waiting",
    );
  });

  it("separates threads that continue from threads that are interrupted", () => {
    const checks = [{ ...idle, activeSessions: 3, continuableSessions: 2 }];
    expect(describeHostActivity(checks, { ...options, continueRunningThreads: true })).toEqual({
      concern: "running",
      lines: [
        "1 thread will be interrupted.",
        "2 threads will continue after the restart.",
        "",
        "Thread names and activity reasons are unavailable from this server.",
      ],
      incomplete: false,
      interrupts: true,
      threadActivity: [],
    });
    expect(describeHostActivity(checks, options).lines).toEqual([
      "3 threads will be interrupted.",
      "",
      "Thread names and activity reasons are unavailable from this server.",
    ]);
  });

  it("treats other environments using shared devices as running work", () => {
    expect(describeHostActivity([{ ...idle, environmentsUsingDevices: 2 }], options)).toEqual({
      concern: "running",
      lines: ["Devices in use by other environments will be disconnected."],
      incomplete: false,
      interrupts: true,
      threadActivity: [],
    });
  });

  it("treats a provider update being installed as running work", () => {
    expect(describeHostActivity([{ ...idle, providerInstalls: 1 }], options)).toEqual({
      concern: "running",
      lines: ["A provider update is installing and will be interrupted."],
      incomplete: false,
      interrupts: true,
      threadActivity: [],
    });
    expect(
      describeHostActivity(
        [
          { ...idle, providerInstalls: 1 },
          { ...idle, providerInstalls: 1 },
        ],
        options,
      ).lines,
    ).toEqual(["2 provider updates are installing and will be interrupted."]);
  });

  it("does not count uninspected terminals as running work", () => {
    expect(
      describeHostActivity(
        [{ ...idle, terminalsRequiringConfirmation: 1, terminalsWithUnknownActivity: 1 }],
        options,
      ),
    ).toEqual({
      concern: "unchecked",
      lines: ["Could not check 1 terminal session for running commands."],
      incomplete: true,
      interrupts: true,
      threadActivity: [],
    });
  });

  it("treats a failed or missing host check as unchecked", () => {
    for (const checks of [[null], []]) {
      expect(describeHostActivity(checks, options)).toEqual({
        concern: "unchecked",
        lines: ["Some hosts could not be checked."],
        incomplete: true,
        interrupts: true,
        threadActivity: [],
      });
    }
  });
});

const namedThread: HostActivityThread = {
  threadId: ThreadId.make("thread"),
  title: "Check the release",
  reasons: ["running", "monitor"],
  continuable: true,
};

describe("idleRestartBlocked", () => {
  it("allows a restart over turns that will resume and terminal commands", () => {
    expect(
      idleRestartBlocked([
        { ...idle, activeSessions: 2, continuableSessions: 2 },
        { ...idle, terminalsRequiringConfirmation: 1, terminalsWithUnknownActivity: 1 },
      ]),
    ).toBe(false);
  });

  it("blocks on waiting sessions, provider installs and shared devices", () => {
    expect(idleRestartBlocked([idle, { ...idle, waitingSessions: 1 }])).toBe(true);
    expect(idleRestartBlocked([{ ...idle, activeSessions: 2, continuableSessions: 1 }])).toBe(true);
    expect(idleRestartBlocked([{ ...idle, providerInstalls: 1 }])).toBe(true);
    expect(idleRestartBlocked([{ ...idle, environmentsUsingDevices: 1 }])).toBe(true);
  });

  it("blocks when a host could not be checked or no host was checked", () => {
    expect(idleRestartBlocked([idle, null])).toBe(true);
    expect(idleRestartBlocked([])).toBe(true);
  });
});

describe("host thread descriptions", () => {
  it("keeps titles, project and host context separate from summary copy", () => {
    const activity = describeHostActivity(
      [
        {
          ...idle,
          activeSessions: 1,
          continuableSessions: 1,
          hostLabel: "Lab server",
          environmentId: EnvironmentId.make("lab"),
          threads: [namedThread],
        },
      ],
      options,
    );
    expect(activity.lines).toEqual(["1 thread will be interrupted."]);
    expect(activity.threadActivity).toEqual([
      {
        thread: namedThread,
        environmentId: EnvironmentId.make("lab"),
        hostLabel: "Lab server",
        continuesAfterRestart: false,
      },
    ]);
  });
  it("labels continuation per host, including matching thread IDs on different hosts", () => {
    const check = { ...idle, activeSessions: 1, continuableSessions: 1, threads: [namedThread] };
    const activity = describeHostActivity(
      [
        { ...check, hostLabel: "Laptop", continueRunningThreads: true },
        { ...check, hostLabel: "Lab server", continueRunningThreads: false },
      ],
      options,
    );
    expect(activity.lines).toEqual([
      "1 thread will be interrupted.",
      "1 thread will continue after the restart.",
    ]);
    expect(activity.threadActivity).toEqual([
      { thread: namedThread, hostLabel: "Laptop", continuesAfterRestart: true },
      { thread: namedThread, hostLabel: "Lab server", continuesAfterRestart: false },
    ]);
  });
  it("keeps unnamed threads visible when a title or project is unavailable", () => {
    const unnamed = { ...namedThread, title: "" };
    const activity = describeHostActivity(
      [
        {
          ...idle,
          activeSessions: 1,
          threads: [unnamed],
        },
      ],
      options,
    );
    expect(activity.lines).toEqual(["1 thread will be interrupted."]);
    expect(activity.threadActivity).toEqual([
      { thread: unnamed, hostLabel: null, continuesAfterRestart: false },
    ]);
  });
  it("keeps known thread details alongside failed host inspections", () => {
    const waiting = { ...namedThread, reasons: ["approval" as const], continuable: false };
    const activity = describeHostActivity(
      [
        {
          ...idle,
          waitingSessions: 1,
          threads: [waiting],
        },
        null,
      ],
      options,
    );
    expect(activity.concern).toBe("waiting");
    expect(activity.incomplete).toBe(true);
    expect(activity.lines).toContain("Some hosts could not be checked.");
    expect(activity.threadActivity).toEqual([
      { thread: waiting, hostLabel: null, continuesAfterRestart: false },
    ]);
  });
});

function activity(
  id: string,
  reasons: ConfirmDialogThreadActivity["thread"]["reasons"],
): ConfirmDialogThreadActivity {
  return {
    hostLabel: null,
    continuesAfterRestart: false,
    thread: {
      threadId: ThreadId.make(id),
      title: `Thread ${id}`,
      reasons,
      continuable: false,
    },
  };
}

describe("groupHostActivityThreads", () => {
  it("lists interrupted threads before threads that continue, grouping each by project", () => {
    const project = {
      id: ProjectId.make("project-a"),
      title: "Sample project",
      workspaceRoot: "/workspace/a",
      faviconPath: null,
      projectIcon: null,
    };
    const inProject = (item: ConfirmDialogThreadActivity) => ({
      ...item,
      thread: { ...item.thread, project },
    });
    const continuing = {
      ...inProject(activity("continuing", ["running"])),
      continuesAfterRestart: true,
    };
    const waiting = activity("waiting", ["input", "monitor"]);
    const command = inProject(activity("command", ["command"]));
    const monitor = inProject(activity("monitor", ["monitor"]));
    const sections = groupHostActivityThreads([continuing, waiting, command, monitor])[0]!.sections;
    expect(sections.map((section) => section.continues)).toEqual([false, true]);
    expect(sections.map((section) => section.projects.map((entry) => entry.activity))).toEqual([
      [[waiting], [command, monitor]],
      [[continuing]],
    ]);
  });

  it("keeps matching thread and project IDs on separate environments distinct", () => {
    const first = {
      ...activity("release", ["running"]),
      environmentId: EnvironmentId.make("laptop"),
      hostLabel: "Laptop",
      continuesAfterRestart: true,
    };
    const second = {
      ...first,
      environmentId: EnvironmentId.make("lab"),
      hostLabel: "Lab server",
      continuesAfterRestart: false,
    };
    const hosts = groupHostActivityThreads([first, second]);
    expect(hosts.map((host) => host.label)).toEqual(["Laptop", "Lab server"]);
    expect(
      hosts.map((host) => host.sections.flatMap((section) => section.projects[0]!.activity)),
    ).toEqual([[first], [second]]);
  });

  it("shares a project heading without merging distinct projects with the same name", () => {
    const project = {
      id: ProjectId.make("project-a"),
      title: "Sample project",
      workspaceRoot: "/workspace/a",
      faviconPath: null,
      projectIcon: null,
    };
    const first = {
      ...activity("first", ["running"]),
      thread: {
        ...activity("first", ["running"]).thread,
        project,
      },
    };
    const second = {
      ...activity("second", ["running"]),
      thread: {
        ...activity("second", ["running"]).thread,
        project,
      },
    };
    const third = {
      ...activity("third", ["running"]),
      thread: {
        ...activity("third", ["running"]).thread,
        project: { ...project, id: ProjectId.make("project-b"), workspaceRoot: "/workspace/b" },
      },
    };
    const projects = groupHostActivityThreads([first, third, second])[0]!.sections[0]!.projects;
    expect(projects.map((entry) => entry.activity)).toEqual([[first, second], [third]]);
  });
});
