import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";

const launcher = ThreadId.make("thread:launcher");
const launched = ThreadId.make("thread:launched");
const middle = ThreadId.make("thread:middle");

const shell = (id: ThreadId, reportsTo?: ThreadId) =>
  ({
    id,
    title: "Thread",
    titleRegeneration: null,
    updatedAt: DateTime.makeUnsafe("2026-11-06T00:00:00Z"),
    deletedAt: null,
    lineage: { parentThreadId: null, relationshipToParent: null },
    ...(reportsTo === undefined ? {} : { reportTo: { threadId: reportsTo } }),
  }) as unknown as OrchestrationV2ThreadShell;

const scope = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const reportToMe = (
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  caller: ThreadId,
  target: ThreadId,
) => {
  const dispatched: Array<string> = [];
  return Effect.gen(function* () {
    const service = yield* ThreadMetadataMcpService.ThreadMetadataMcpService;
    const outcome = yield* service
      .update(scope(caller), { threadId: target, action: "report_to_me" })
      .pipe(
        Effect.map(() => "accepted"),
        Effect.catch((error) => Effect.succeed(error.code as string)),
      );
    return { outcome, dispatched };
  }).pipe(
    Effect.provide(
      ThreadMetadataMcpService.layer.pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Effect.succeed(shells.find((candidate) => candidate.id === threadId) ?? null),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command.type);
                return { sequence: 1, storedEvents: [] } as never;
              }),
          }),
        ),
      ),
    ),
  );
};

it.effect.each([
  ["an unrelated thread", launched, [shell(launcher), shell(launched)], "accepted"],
  // The launched thread cannot point its own launcher back at itself.
  ["a direct cycle", launcher, [shell(launcher), shell(launched, launcher)], "invalid_request"],
  [
    "a longer cycle",
    launcher,
    [shell(launcher), shell(middle, launcher), shell(launched, middle)],
    "invalid_request",
  ],
] as const)("report_to_me with %s", ([_name, target, shells, expected]) =>
  Effect.gen(function* () {
    const caller = target === launched ? launcher : launched;
    const { outcome, dispatched } = yield* reportToMe(shells, caller, target);
    assert.equal(outcome, expected);
    assert.deepEqual(dispatched, expected === "accepted" ? ["thread.report-target.set"] : []);
  }),
);
