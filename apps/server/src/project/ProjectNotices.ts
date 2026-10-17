import {
  PROJECT_NOTICE_DEFAULT_EXPIRY_HOURS,
  PROJECT_NOTICE_MAX_ACTIVE,
  ProjectNotice,
  ProjectNoticeLimitError,
  ProjectNoticePersistenceError,
  ProjectNoticeId,
  type ProjectId,
  type ProjectNoticeListResult,
  type ProjectNoticeResolveResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

export interface ProjectNoticePostInput {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly body: string;
  readonly authorThreadId: ThreadId | null;
  readonly expiresInHours?: number | undefined;
}

/**
 * Project notices: short-lived messages agents leave for other threads in the
 * same project. Only active notices are stored; resolving deletes the row and
 * expired rows are deleted on the next write.
 */
export class ProjectNotices extends Context.Service<
  ProjectNotices,
  {
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectNoticeListResult, ProjectNoticePersistenceError>;
    readonly post: (
      input: ProjectNoticePostInput,
    ) => Effect.Effect<ProjectNotice, ProjectNoticeLimitError | ProjectNoticePersistenceError>;
    readonly resolve: (
      noticeId: ProjectNoticeId,
    ) => Effect.Effect<ProjectNoticeResolveResult, ProjectNoticePersistenceError>;
    readonly subscribe: (
      projectId: ProjectId,
    ) => Stream.Stream<ProjectNoticeListResult, ProjectNoticePersistenceError>;
  }
>()("@styal/cli/project/ProjectNotices") {}

const decodeNotices = Schema.decodeUnknownEffect(Schema.Array(ProjectNotice));

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  // Publishes the project id whose notices changed; subscribers re-list that project.
  const changes = yield* PubSub.unbounded<ProjectId>();

  const activeRows = (projectId: ProjectId, now: string) => sql<Record<string, unknown>>`
    SELECT
      notice_id AS "id",
      project_id AS "projectId",
      title,
      body,
      author_thread_id AS "authorThreadId",
      created_at AS "createdAt",
      expires_at AS "expiresAt"
    FROM project_notices
    WHERE project_id = ${projectId} AND expires_at > ${now}
    ORDER BY created_at DESC, notice_id DESC
  `;

  const list = Effect.fn("ProjectNotices.list")(function* (projectId: ProjectId) {
    const rows = yield* activeRows(projectId, yield* nowIso).pipe(
      Effect.mapError((cause) => new ProjectNoticePersistenceError({ operation: "list", cause })),
    );
    const notices = yield* decodeNotices(rows).pipe(
      Effect.mapError((cause) => new ProjectNoticePersistenceError({ operation: "list", cause })),
    );
    return { notices };
  });

  const post = Effect.fn("ProjectNotices.post")(function* (input: ProjectNoticePostInput) {
    const now = yield* DateTime.now;
    const createdAt = DateTime.formatIso(now);
    const hours = input.expiresInHours ?? PROJECT_NOTICE_DEFAULT_EXPIRY_HOURS;
    const expiresAt = DateTime.formatIso(
      DateTime.add(now, { milliseconds: Math.round(hours * 3_600_000) }),
    );
    const id = ProjectNoticeId.make(`notice-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
    const notice = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM project_notices WHERE expires_at <= ${createdAt}`;
          const [count] = yield* sql<{ readonly active: number }>`
            SELECT COUNT(*) AS "active" FROM project_notices WHERE project_id = ${input.projectId}
          `;
          if ((count?.active ?? 0) >= PROJECT_NOTICE_MAX_ACTIVE) {
            return yield* new ProjectNoticeLimitError({ limit: PROJECT_NOTICE_MAX_ACTIVE });
          }
          yield* sql`
            INSERT INTO project_notices (
              notice_id, project_id, title, body, author_thread_id, created_at, expires_at
            ) VALUES (
              ${id}, ${input.projectId}, ${input.title}, ${input.body},
              ${input.authorThreadId}, ${createdAt}, ${expiresAt}
            )
          `;
          return {
            id,
            projectId: input.projectId,
            title: input.title,
            body: input.body,
            authorThreadId: input.authorThreadId,
            createdAt,
            expiresAt,
          } satisfies ProjectNotice;
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: (cause) => new ProjectNoticePersistenceError({ operation: "post", cause }),
        }),
      );
    yield* PubSub.publish(changes, input.projectId);
    return notice;
  });

  const resolve = Effect.fn("ProjectNotices.resolve")(function* (noticeId: ProjectNoticeId) {
    const deleted = yield* sql<{ readonly projectId: ProjectId; readonly expiresAt: string }>`
      DELETE FROM project_notices
      WHERE notice_id = ${noticeId}
      RETURNING project_id AS "projectId", expires_at AS "expiresAt"
    `.pipe(
      Effect.mapError(
        (cause) => new ProjectNoticePersistenceError({ operation: "resolve", cause }),
      ),
    );
    const row = deleted[0];
    if (row === undefined) return { wasActive: false };
    yield* PubSub.publish(changes, row.projectId);
    return { wasActive: row.expiresAt > (yield* nowIso) };
  });

  /**
   * The project's active notices: a snapshot, then a fresh list after every change to the
   * project and whenever its next notice expires, so open clients drop expired notices.
   */
  const subscribe = (projectId: ProjectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the snapshot so a change between the two is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        const nextChange: Effect.Effect<void> = PubSub.take(subscription).pipe(
          Effect.flatMap((changed) => (changed === projectId ? Effect.void : nextChange)),
        );
        const untilNextExpiry = (current: ProjectNoticeListResult) =>
          Effect.gen(function* () {
            if (current.notices.length === 0) return yield* Effect.never;
            const now = yield* Clock.currentTimeMillis;
            const next = Math.min(...current.notices.map((notice) => Date.parse(notice.expiresAt)));
            yield* Effect.sleep(Duration.millis(Math.max(0, next - now)));
          });
        let current = yield* list(projectId);
        const refreshed = Effect.gen(function* () {
          yield* Effect.race(nextChange, untilNextExpiry(current));
          current = yield* list(projectId);
          return current;
        });
        return Stream.concat(Stream.make(current), Stream.fromEffectRepeat(refreshed));
      }),
    );

  return ProjectNotices.of({ list, post, resolve, subscribe });
});

export const layer = Layer.effect(ProjectNotices, make);
