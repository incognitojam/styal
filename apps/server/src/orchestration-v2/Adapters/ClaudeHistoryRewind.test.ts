// @effect-diagnostics nodeBuiltinImport:off - native SDK filesystem fixture
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";

import { ClaudeSessionHistoryMessage } from "../../provider/claudeSessionHistory.ts";
import { runScopedClaudeHistory } from "./ClaudeAdapterV2.ts";
import { remapClaudeForkTurnBoundaries } from "./ClaudeHistoryRewind.ts";

const decodeHistory = Schema.decodeSync(
  Schema.fromJsonString(Schema.Array(ClaudeSessionHistoryMessage)),
);
const decodeFork = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ sessionId: Schema.String })),
);

describe("Claude full native history rewind", () => {
  it.effect(
    "keeps disconnected saved history and unknown older boundaries through isolated native forks",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const scratchDir = NodePath.resolve(import.meta.dirname, "../../../../../.scratch");
          NodeFS.mkdirSync(scratchDir, { recursive: true });
          const baseDir = NodeFS.mkdtempSync(
            NodePath.join(scratchDir, "upstream-v2-claude-rewind-native-"),
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
          );
          const cwd = NodePath.join(baseDir, "workspace");
          const configDir = NodePath.join(baseDir, "claude-home");
          const projectDir = NodePath.join(
            configDir,
            "projects",
            cwd.replace(/[^a-zA-Z0-9-]/g, "-"),
          );
          NodeFS.mkdirSync(cwd, { recursive: true });
          NodeFS.mkdirSync(projectDir, { recursive: true });
          const sessionId = "550e8400-e29b-41d4-a716-446655440010";
          const uuid = (value: number) =>
            `550e8400-e29b-41d4-a716-${String(value).padStart(12, "0")}`;
          const entry = (type: string, id: number, parent: number | null, content: string) => ({
            type,
            uuid: uuid(id),
            parentUuid: parent === null ? null : uuid(parent),
            sessionId,
            cwd,
            timestamp: "2026-01-01T00:00:00.000Z",
            message: { role: type, content },
          });
          const history = [
            entry("user", 101, null, "repeat this prompt"),
            entry("assistant", 201, 101, "first"),
            entry("user", 102, null, "repeat this prompt"),
            entry("assistant", 202, 102, "second"),
            entry("user", 402, 202, "steer second"),
            entry("assistant", 203, 402, "second after steer"),
            { ...entry("system", 302, 203, "trailing notice"), subtype: "stop_hook_summary" },
            entry("user", 103, 302, "remove third"),
            entry("assistant", 204, 103, "third"),
          ];
          const sourcePath = NodePath.join(projectDir, `${sessionId}.jsonl`);
          const source = history.map((row) => JSON.stringify(row)).join("\n") + "\n";
          NodeFS.writeFileSync(sourcePath, source);
          const filtered = yield* Effect.promise(() =>
            getSessionMessages(sessionId, {
              dir: cwd,
              includeSystemMessages: true,
              sessionStore: { load: async () => history, append: async () => {} },
            }),
          );
          assert.isFalse(filtered.some((row) => row.uuid === uuid(101)));
          const input = {
            sessionId,
            options: { dir: cwd },
            environment: { CLAUDE_CONFIG_DIR: configDir },
            threadId: ThreadId.make("thread-native-rewind"),
            providerSessionId: ProviderSessionId.make("session-native-rewind"),
          };
          const full = decodeHistory(
            yield* Effect.promise(() => runScopedClaudeHistory(input, "readSessionHistory")),
          );
          assert.isTrue(full.some((row) => row.uuid === uuid(101)));
          const fork = decodeFork(
            yield* Effect.promise(() =>
              runScopedClaudeHistory(
                { ...input, options: { dir: cwd, upToMessageId: uuid(302) } },
                "forkSession",
              ),
            ),
          );
          const retained = decodeHistory(
            yield* Effect.promise(() =>
              runScopedClaudeHistory({ ...input, sessionId: fork.sessionId }, "readSessionHistory"),
            ),
          );
          const remapped = remapClaudeForkTurnBoundaries(
            full,
            retained,
            full.findIndex((row) => row.uuid === uuid(103)),
            [null, uuid(102)],
          );
          assert.isDefined(remapped);
          assert.isNull(remapped![0]);
          assert.notEqual(remapped![1], uuid(102));
          assert.isTrue(
            retained.some(
              (row) =>
                row.message &&
                typeof row.message === "object" &&
                "content" in row.message &&
                row.message.content === "steer second",
            ),
          );
          const firstRemoved = retained.findIndex((row) => row.uuid === remapped![1]);
          const secondFork = decodeFork(
            yield* Effect.promise(() =>
              runScopedClaudeHistory(
                {
                  ...input,
                  sessionId: fork.sessionId,
                  options: { dir: cwd, upToMessageId: retained[firstRemoved - 1]!.uuid },
                },
                "forkSession",
              ),
            ),
          );
          const second = decodeHistory(
            yield* Effect.promise(() =>
              runScopedClaudeHistory(
                { ...input, sessionId: secondFork.sessionId },
                "readSessionHistory",
              ),
            ),
          );
          assert.deepEqual(remapClaudeForkTurnBoundaries(retained, second, firstRemoved, [null]), [
            null,
          ]);
          assert.equal(NodeFS.readFileSync(sourcePath, "utf8"), source);
          const known = [uuid(101), uuid(102)];
          assert.isUndefined(remapClaudeForkTurnBoundaries(full, retained.slice(1), 7, known));
          assert.isUndefined(remapClaudeForkTurnBoundaries(full, retained.toReversed(), 7, known));
        }),
      ),
  );
});
