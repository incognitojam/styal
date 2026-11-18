import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { assertProjectCoordinatorsBelong, reportRecipient } from "./ProjectCoordinator.ts";

const app = ProjectId.make("project:app");
const docs = ProjectId.make("project:docs");
const launcher = ThreadId.make("thread:launcher");
const worker = ThreadId.make("thread:worker");
const first = ThreadId.make("thread:first-coordinator");
const second = ThreadId.make("thread:second-coordinator");
const elsewhere = ThreadId.make("thread:docs-thread");

const projectOf = new Map([
  [launcher, app],
  [worker, app],
  [first, app],
  [second, app],
  [elsewhere, docs],
]);
const lookup = (coordinator: ThreadId | null, enabled = true) => ({
  settings: Effect.succeed({
    ...DEFAULT_SERVER_SETTINGS,
    projectCoordinatorsEnabled: enabled,
    projectCoordinators: coordinator === null ? {} : { [app]: { threadId: coordinator } },
  }),
  getThreadShell: (threadId: ThreadId) =>
    Effect.succeed(
      projectOf.has(threadId) ? { projectId: projectOf.get(threadId)!, deletedAt: null } : null,
    ),
});
const coordinated = {
  id: worker,
  projectId: app,
  reportTo: { threadId: first, source: "project-coordinator" as const },
};

describe("reportRecipient", () => {
  it.effect.each([
    ["follows the coordinator the project has now", lookup(second), second],
    ["stops once the coordinator is cleared", lookup(null), null],
    ["stops while project coordinators are off", lookup(second, false), null],
    ["refuses a coordinator from another project", lookup(elsewhere), null],
    ["never reports to itself", lookup(worker), null],
  ] as const)("%s", ([, deps, expected]) =>
    Effect.gen(function* () {
      assert.equal(yield* reportRecipient(deps, coordinated), expected);
    }),
  );

  it.effect("keeps the launcher of a thread that asked to hear back", () =>
    Effect.gen(function* () {
      const launched = { id: worker, projectId: app, reportTo: { threadId: launcher } };
      assert.equal(yield* reportRecipient(lookup(second), launched), launcher);
    }),
  );
});

describe("assertProjectCoordinatorsBelong", () => {
  it.effect("accepts a thread of the project and refuses one from another project", () =>
    Effect.gen(function* () {
      const { getThreadShell } = lookup(null);
      yield* assertProjectCoordinatorsBelong(getThreadShell, {
        projectCoordinators: { [app]: { threadId: first }, [docs]: null },
      });
      const refused = yield* assertProjectCoordinatorsBelong(getThreadShell, {
        projectCoordinators: { [app]: { threadId: elsewhere } },
      }).pipe(Effect.flip);
      assert.equal(refused.operation, "set-project-coordinator");
    }),
  );
});
