import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { PROJECT_NOTICE_MAX_ACTIVE, ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runAllMigrations } from "../persistence/ForkMigrations.ts";
import * as ProjectNotices from "./ProjectNotices.ts";

const layer = it.layer(
  ProjectNotices.layer.pipe(
    Layer.provideMerge(
      Layer.merge(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCrypto.layer),
    ),
  ),
);

const projectA = ProjectId.make("notice-project-a");
const projectB = ProjectId.make("notice-project-b");

layer("ProjectNotices", (it) => {
  it.effect("lists a project's active notices newest first and hides expired ones", () =>
    Effect.gen(function* () {
      yield* runAllMigrations();
      const notices = yield* ProjectNotices.ProjectNotices;
      const author = ThreadId.make("notice-author");

      const short = yield* notices.post({
        projectId: projectA,
        title: "Main is broken",
        body: "Wait for the fix before rebasing.",
        authorThreadId: author,
        expiresInHours: 1,
      });
      yield* TestClock.adjust("1 minute");
      const long = yield* notices.post({
        projectId: projectA,
        title: "Refactoring ws.ts",
        body: "",
        authorThreadId: null,
      });
      yield* notices.post({
        projectId: projectB,
        title: "Other project",
        body: "",
        authorThreadId: null,
      });

      assert.deepStrictEqual(
        (yield* notices.list(projectA)).notices.map((notice) => notice.id),
        [long.id, short.id],
      );
      assert.equal(short.authorThreadId, author);

      yield* TestClock.adjust("1 hour");
      assert.deepStrictEqual(
        (yield* notices.list(projectA)).notices.map((notice) => notice.id),
        [long.id],
      );
    }),
  );

  it.effect("resolves a notice once and reports whether it was still active", () =>
    Effect.gen(function* () {
      yield* runAllMigrations();
      const notices = yield* ProjectNotices.ProjectNotices;
      const notice = yield* notices.post({
        projectId: projectA,
        title: "Hold merges",
        body: "",
        authorThreadId: null,
      });

      assert.deepStrictEqual(yield* notices.resolve(notice.id), { wasActive: true });
      assert.deepStrictEqual(yield* notices.resolve(notice.id), { wasActive: false });
      assert.notInclude(
        (yield* notices.list(projectA)).notices.map((entry) => entry.id),
        notice.id,
      );
    }),
  );

  it.effect("refuses a notice past the active limit until one expires", () =>
    Effect.gen(function* () {
      yield* runAllMigrations();
      const notices = yield* ProjectNotices.ProjectNotices;
      const projectId = ProjectId.make("notice-project-full");
      for (let index = 0; index < PROJECT_NOTICE_MAX_ACTIVE; index++) {
        yield* notices.post({
          projectId,
          title: `Notice ${index}`,
          body: "",
          authorThreadId: null,
          expiresInHours: 1,
        });
      }

      const refused = yield* notices
        .post({ projectId, title: "One too many", body: "", authorThreadId: null })
        .pipe(Effect.flip);
      assert.include(refused.message, "active notices");
      assert.equal(refused.cause, undefined);

      yield* TestClock.adjust("2 hours");
      yield* notices.post({ projectId, title: "After expiry", body: "", authorThreadId: null });
      assert.equal((yield* notices.list(projectId)).notices.length, 1);
    }),
  );

  it.effect("streams a fresh list to subscribers of the changed project only", () =>
    Effect.gen(function* () {
      yield* runAllMigrations();
      const notices = yield* ProjectNotices.ProjectNotices;
      const projectId = ProjectId.make("notice-project-stream");
      const lists = yield* Queue.unbounded<ReadonlyArray<string>>();
      yield* notices.subscribe(projectId).pipe(
        Stream.runForEach((result) =>
          Queue.offer(
            lists,
            result.notices.map((notice) => notice.title),
          ),
        ),
        Effect.forkChild,
      );
      assert.deepStrictEqual(yield* Queue.take(lists), []);

      yield* notices.post({
        projectId: projectB,
        title: "Elsewhere",
        body: "",
        authorThreadId: null,
      });
      const first = yield* notices.post({
        projectId,
        title: "First",
        body: "",
        authorThreadId: null,
      });
      // The other project's notice did not wake this subscriber.
      assert.deepStrictEqual(yield* Queue.take(lists), ["First"]);

      yield* notices.resolve(first.id);
      assert.deepStrictEqual(yield* Queue.take(lists), []);
    }),
  );
});
