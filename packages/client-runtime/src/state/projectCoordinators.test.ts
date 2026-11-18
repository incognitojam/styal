import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { projectCoordinatorKeys, shownReportRecipientId } from "./projectCoordinators.ts";

const env = EnvironmentId.make("env-local");
const app = ProjectId.make("project-app");
const docs = ProjectId.make("project-docs");
const chat = ThreadId.make("thread-chat");
const worker = ThreadId.make("thread-worker");

describe("project coordinators on clients", () => {
  it("keys a coordinator by its project, so a thread of another project never matches", () => {
    const keys = projectCoordinatorKeys(env, {
      projectCoordinatorsEnabled: true,
      projectCoordinators: { [app]: { threadId: chat } },
    });
    // The menu and rows look a thread up by its own project: the same id in docs is not app's.
    expect(keys).toContain(`${env}:${app}:${chat}`);
    expect(keys).not.toContain(`${env}:${docs}:${chat}`);
  });

  it("shows no coordinator recipient that is listed in another project", () => {
    const thread = {
      id: worker,
      projectId: app,
      reportTo: { threadId: chat, source: "project-coordinator" as const },
    };
    expect(shownReportRecipientId(thread, chat, docs)).toBeNull();
    expect(shownReportRecipientId(thread, chat, app)).toBe(chat);
    // Not listed yet: shown, as the server will route once it exists in this project.
    expect(shownReportRecipientId(thread, chat, null)).toBe(chat);
    // A launcher may be in any project.
    const launched = { ...thread, reportTo: { threadId: chat } };
    expect(shownReportRecipientId(launched, chat, docs)).toBe(chat);
  });
});
