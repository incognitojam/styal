import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ConfirmDialogThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { groupHostActivityThreads } from "./HostActivityThreadList.logic";

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
      projectTitle: "Sample project",
      reasons,
      continuable: false,
    },
  };
}

describe("groupHostActivityThreads", () => {
  it("groups by current activity, keeping mixed work in one place and preserving its reasons", () => {
    const waiting = activity("waiting", ["input", "monitor"]);
    const monitor = activity("monitor", ["monitor"]);
    const mixed = activity("mixed", ["running", "monitor"]);
    const command = activity("command", ["command"]);
    const groups = groupHostActivityThreads([waiting, monitor, mixed, command])[0]!.groups;
    expect(groups.map((group) => group.label)).toEqual([
      "Running",
      "Monitoring",
      "Waiting for input or approval",
    ]);
    expect(groups.map((group) => group.projects.flatMap((project) => project.activity))).toEqual([
      [mixed, command],
      [monitor],
      [waiting],
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
    expect(hosts.map((host) => host.groups[0]!.projects[0]!.activity)).toEqual([[first], [second]]);
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
    const projects = groupHostActivityThreads([first, third, second])[0]!.groups[0]!.projects;
    expect(projects.map((entry) => entry.activity)).toEqual([[first, second], [third]]);
  });
});
