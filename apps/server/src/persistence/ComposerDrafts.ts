import {
  ComposerDraftCommon,
  type ComposerDraftGetInput,
  type ComposerDraftSnapshot,
  type ComposerDraftUpdateInput,
  type ComposerDraftUpdateResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export class ComposerDraftPersistenceError extends Schema.TaggedErrorClass<ComposerDraftPersistenceError>()(
  "ComposerDraftPersistenceError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class ComposerDraftRepository extends Context.Service<
  ComposerDraftRepository,
  {
    readonly get: (
      input: ComposerDraftGetInput,
    ) => Effect.Effect<ComposerDraftSnapshot, ComposerDraftPersistenceError>;
    readonly update: (
      input: ComposerDraftUpdateInput,
    ) => Effect.Effect<ComposerDraftUpdateResult, ComposerDraftPersistenceError>;
    readonly subscribe: (
      input: ComposerDraftGetInput,
    ) => Stream.Stream<ComposerDraftSnapshot, ComposerDraftPersistenceError>;
  }
>()("t3/persistence/ComposerDrafts/ComposerDraftRepository") {}

const DbRow = Schema.Struct({
  threadId: ThreadId,
  revision: Schema.Int,
  common: Schema.NullOr(Schema.fromJsonString(ComposerDraftCommon)),
  updatedAt: Schema.String,
  clientMutationId: Schema.String,
});

const RawDbRow = Schema.Struct({
  threadId: Schema.Unknown,
  revision: Schema.Unknown,
  common: Schema.Unknown,
  updatedAt: Schema.Unknown,
  clientMutationId: Schema.Unknown,
});

const WriteRow = Schema.Struct({
  threadId: ThreadId,
  baseRevision: Schema.Int,
  nextRevision: Schema.Int,
  common: Schema.NullOr(Schema.fromJsonString(ComposerDraftCommon)),
  updatedAt: Schema.String,
  clientMutationId: Schema.String,
});

const decodeRow = Schema.decodeUnknownEffect(DbRow);
const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

function emptySnapshot(threadId: ThreadId): ComposerDraftSnapshot {
  return {
    threadId,
    revision: 0,
    common: null,
    updatedAt: null,
    clientMutationId: null,
  };
}

function toSnapshot(row: typeof DbRow.Type): ComposerDraftSnapshot {
  return {
    threadId: row.threadId,
    revision: row.revision,
    common: row.common,
    updatedAt: row.updatedAt,
    clientMutationId: row.clientMutationId,
  };
}

function mapPersistenceError(operation: string) {
  return (cause: unknown) => new ComposerDraftPersistenceError({ operation, cause });
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<ComposerDraftSnapshot>();

  const getRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: RawDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        revision,
        common_json AS "common",
        updated_at AS "updatedAt",
        client_mutation_id AS "clientMutationId"
      FROM composer_drafts
      WHERE thread_id = ${threadId}
    `,
  });

  const insertRow = SqlSchema.findAll({
    Request: WriteRow,
    Result: RawDbRow,
    execute: (row) => sql`
      INSERT INTO composer_drafts (
        thread_id, revision, common_json, updated_at, client_mutation_id
      ) VALUES (
        ${row.threadId}, ${row.nextRevision}, ${row.common}, ${row.updatedAt},
        ${row.clientMutationId}
      )
      ON CONFLICT (thread_id) DO NOTHING
      RETURNING
        thread_id AS "threadId",
        revision,
        common_json AS "common",
        updated_at AS "updatedAt",
        client_mutation_id AS "clientMutationId"
    `,
  });

  const updateRow = SqlSchema.findAll({
    Request: WriteRow,
    Result: RawDbRow,
    execute: (row) => sql`
      UPDATE composer_drafts
      SET
        revision = ${row.nextRevision},
        common_json = ${row.common},
        updated_at = ${row.updatedAt},
        client_mutation_id = ${row.clientMutationId}
      WHERE thread_id = ${row.threadId}
        AND revision = ${row.baseRevision}
      RETURNING
        thread_id AS "threadId",
        revision,
        common_json AS "common",
        updated_at AS "updatedAt",
        client_mutation_id AS "clientMutationId"
    `,
  });

  const get: ComposerDraftRepository["Service"]["get"] = Effect.fn("ComposerDraftRepository.get")(
    function* (input) {
      const row = yield* getRow(input).pipe(
        Effect.mapError(mapPersistenceError("ComposerDraftRepository.get:query")),
      );
      if (Option.isNone(row)) return emptySnapshot(input.threadId);
      const decoded = yield* decodeRow(row.value).pipe(
        Effect.mapError(mapPersistenceError("ComposerDraftRepository.get:decode")),
      );
      return toSnapshot(decoded);
    },
  );

  const update: ComposerDraftRepository["Service"]["update"] = Effect.fn(
    "ComposerDraftRepository.update",
  )(function* (input) {
    const write = {
      ...input,
      nextRevision: input.baseRevision + 1,
      updatedAt: yield* currentIsoTimestamp,
    };
    const rows = yield* (input.baseRevision === 0 ? insertRow(write) : updateRow(write)).pipe(
      Effect.mapError(mapPersistenceError("ComposerDraftRepository.update:query")),
    );
    const row = rows[0];
    if (row === undefined) {
      return { _tag: "conflict", snapshot: yield* get(input) } as const;
    }
    const decoded = yield* decodeRow(row).pipe(
      Effect.mapError(mapPersistenceError("ComposerDraftRepository.update:decode")),
    );
    const snapshot = toSnapshot(decoded);
    yield* PubSub.publish(changes, snapshot);
    return { _tag: "accepted", snapshot } as const;
  });

  const subscribe: ComposerDraftRepository["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const initial = yield* get(input);
        return Stream.concat(
          Stream.make(initial),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((snapshot) => snapshot.threadId === input.threadId),
          ),
        );
      }),
    );

  return ComposerDraftRepository.of({ get, update, subscribe });
});

export const layer = Layer.effect(ComposerDraftRepository, make);
