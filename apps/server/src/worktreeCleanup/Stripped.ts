import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const makeConsume = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return Effect.fn("WorktreeCleanup.consumeStripped")(function* (worktreePath: string) {
    const rows =
      yield* sql`DELETE FROM worktree_stripped WHERE worktree_path = ${worktreePath} RETURNING worktree_path`;
    return rows.length > 0;
  });
});
