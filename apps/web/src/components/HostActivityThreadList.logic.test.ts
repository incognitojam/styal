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
