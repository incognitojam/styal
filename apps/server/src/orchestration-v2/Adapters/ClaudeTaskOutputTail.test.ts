import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";

import { claudeTaskOutputRoot, tailClaudeTaskOutput } from "./ClaudeTaskOutputTail.ts";

const SESSION_ID = "0c91bb28-9e89-4889-bd22-3de9880233d3";
const TASK_ID = "bk6xreeye";

const makeTaskFile = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-task-output-" });
  const tasks = path.join(root, "-private-tmp-project", SESSION_ID, "tasks");
  return { root, tasks, file: path.join(tasks, `${TASK_ID}.output`) };
});

// TestClock cannot interleave with real filesystem I/O; use the live clock.
describe("tailClaudeTaskOutput", () => {
  it.live("follows a file that appears after the task starts, across split characters", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, tasks, file } = yield* makeTaskFile;
        const chunks = yield* Queue.unbounded<string>();
        yield* tailClaudeTaskOutput({
          root,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop: yield* Deferred.make<void>(),
          onChunk: (chunk) => Queue.offer(chunks, chunk),
        }).pipe(Effect.forkScoped);

        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        // Split the two-byte é across writes.
        const encoded = new TextEncoder().encode("café 1\n");
        yield* fileSystem.writeFile(file, encoded.subarray(0, 4));
        assert.equal(yield* Queue.take(chunks), "caf");

        yield* fileSystem.writeFile(file, encoded);
        assert.equal(yield* Queue.take(chunks), "é 1\n");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("skips ahead when the command writes faster than it is read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, tasks, file } = yield* makeTaskFile;
        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        yield* fileSystem.writeFileString(file, "start\n");
        const chunks = yield* Queue.unbounded<string>();
        yield* tailClaudeTaskOutput({
          root,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop: yield* Deferred.make<void>(),
          onChunk: (chunk) => Queue.offer(chunks, chunk),
        }).pipe(Effect.forkScoped);
        assert.equal(yield* Queue.take(chunks), "start\n");

        yield* fileSystem.writeFileString(file, `start\n${"y\n".repeat(1_000_000)}end\n`);
        const flooded = yield* Queue.take(chunks);
        assert.isAtMost(flooded.length, 256 * 1024 + 1);
        assert.isTrue(flooded.startsWith("\n"));
        assert.isTrue(flooded.endsWith("y\nend\n"));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reads what was written last when the tool result stops it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, tasks, file } = yield* makeTaskFile;
        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        yield* fileSystem.writeFileString(file, "one\n");
        const chunks: Array<string> = [];
        const stop = yield* Deferred.make<void>();
        const first = yield* Deferred.make<void>();
        const fiber = yield* tailClaudeTaskOutput({
          root,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop,
          onChunk: (chunk) =>
            Effect.sync(() => chunks.push(chunk)).pipe(
              Effect.andThen(Deferred.succeed(first, undefined)),
            ),
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(first);
        yield* fileSystem.writeFileString(file, "one\ntwo\n");
        yield* Deferred.succeed(stop, undefined);
        yield* Fiber.join(fiber);
        assert.deepEqual(chunks, ["one\n", "two\n"]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});

// Node has no uid on Windows; replacing process.getuid lets this host take that branch.
const withoutUid = Effect.acquireRelease(
  Effect.sync(() => {
    const getuid = process.getuid;
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    return getuid;
  }),
  (getuid) =>
    Effect.sync(() => {
      Object.defineProperty(process, "getuid", { value: getuid, configurable: true });
    }),
);

describe("claudeTaskOutputRoot on Windows", () => {
  it.live("finds a running command's output under Claude Code's TEMP folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-windows-temp-" });
        const tasks = path.join(temp, "claude-0", "C--Users-dev-project", SESSION_ID, "tasks");
        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        yield* fileSystem.writeFileString(path.join(tasks, `${TASK_ID}.output`), "line 1\r\n");
        yield* withoutUid;

        const root = claudeTaskOutputRoot({ TEMP: temp, TMP: "/unused" }, path);
        assert.equal(root, path.join(temp, "claude-0"));
        const chunks = yield* Queue.unbounded<string>();
        const stop = yield* Deferred.make<void>();
        const tail = yield* tailClaudeTaskOutput({
          root: root!,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop,
          onChunk: (chunk) => Queue.offer(chunks, chunk),
        }).pipe(Effect.forkScoped);
        assert.equal(yield* Queue.take(chunks), "line 1\r\n");
        yield* Deferred.succeed(stop, undefined);
        yield* Fiber.join(tail);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("prefers CLAUDE_CODE_TMPDIR and falls back to the system temp folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* withoutUid;

        assert.equal(
          claudeTaskOutputRoot({ CLAUDE_CODE_TMPDIR: "/configured", TEMP: "/temp" }, path),
          path.join("/configured", "claude-0"),
        );
        assert.equal(
          claudeTaskOutputRoot({ SystemRoot: "/windows" }, path),
          path.join("/windows", "temp", "claude-0"),
        );
        assert.isUndefined(claudeTaskOutputRoot({}, path));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
