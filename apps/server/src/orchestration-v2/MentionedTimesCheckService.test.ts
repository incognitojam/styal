import { assert, describe, it, vi } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as MentionedTimesCheck from "./MentionedTimesCheckService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:mentioned-times");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in mentioned time tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

function makeHarness(enabled: boolean) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "mentioned-times-check" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest({ mentionedTimeCheckEnabled: enabled });
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const checkMentionedTimes = vi.fn<
    TextGeneration.TextGeneration["Service"]["checkMentionedTimes"]
  >(() =>
    Effect.succeed({
      spans: [
        { span: 1, kind: "length" as const, time: null, zone: null, date: null },
        { span: 2, kind: "moment" as const, time: "19:08", zone: null, date: "2026-09-29" },
      ],
    }),
  );
  const layerProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: () =>
      Effect.succeedSome({
        projectId,
        title: "Project",
        workspaceRoot: "/repo",
        defaultModelSelection: modelSelection,
        defaultThreadEnvMode: null,
        autoPull: false,
        faviconPath: null,
        projectIcon: null,
        scripts: [],
        pinnedAt: null,
        pinOrderKey: null,
        archivedAt: null,
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
        deletedAt: null,
      }),
  });
  const layerCheck = MentionedTimesCheck.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreadManagement,
        layerProjects,
        Layer.mock(TextGeneration.TextGeneration)({ checkMentionedTimes }),
        layerServerSettings,
        layerOrchestrator,
        IdAllocator.layer,
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(layerOrchestrator, layerThreadManagement, layerCheck),
    checkMentionedTimes,
  };
}

const threadId = ThreadId.make("thread:mentioned-times");
const messageId = MessageId.make("message:mentioned-times");
const reply = "The call took 17:25. The stall on terra at 19:08 hit one of these steps.";

const seedReply = (text: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make("command:create"),
      threadId,
      projectId,
      title: "Thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* writeReply(text, "seed");
  });

const writeReply = (text: string, key: string) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`event:reply:${key}`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: messageId,
            threadId,
            runId: null,
            nodeId: null,
            role: "assistant",
            text,
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
  });

const storedReply = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const records = yield* threads.getThreadRecords(threadId, ["messages"], {
    messageIds: [messageId],
  });
  return records.messages.find((message) => message.id === messageId);
});

describe("MentionedTimesCheckService", () => {
  it.effect("does nothing while the setting is off", () => {
    const harness = makeHarness(false);
    return Effect.gen(function* () {
      yield* seedReply(reply);
      const service = yield* MentionedTimesCheck.MentionedTimesCheckService;
      yield* service.execute({ threadId, messageId });
      assert.strictEqual(harness.checkMentionedTimes.mock.calls.length, 0);
      assert.isUndefined((yield* storedReply)?.mentionedTimes);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "stores the model's reading and keeps it while a re-sent reply has the same text",
    () => {
      const harness = makeHarness(true);
      return Effect.gen(function* () {
        yield* seedReply(reply);
        const service = yield* MentionedTimesCheck.MentionedTimesCheckService;
        yield* service.execute({ threadId, messageId });

        const [request] = harness.checkMentionedTimes.mock.calls[0]!;
        assert.include(request.markedMessage, "took [s1]⟦17:25⟧");
        assert.include(request.markedMessage, "at [s2]⟦19:08⟧");
        const spans = (yield* storedReply)?.mentionedTimes?.spans;
        assert.deepStrictEqual(spans, [
          {
            start: reply.indexOf("17:25"),
            end: reply.indexOf("17:25") + 5,
            text: "17:25",
            kind: "length",
          },
          {
            start: reply.indexOf("19:08"),
            end: reply.indexOf("19:08") + 5,
            text: "19:08",
            kind: "moment",
            time: "19:08",
            date: "2026-09-29",
          },
        ]);

        yield* writeReply(reply, "resent");
        assert.deepStrictEqual((yield* storedReply)?.mentionedTimes?.spans, spans);
        // An edited reply drops the reading, so its chips fall back to the rules.
        yield* writeReply(`${reply} Edited.`, "edited");
        assert.isUndefined((yield* storedReply)?.mentionedTimes);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("skips a reply with no clock time", () => {
    const harness = makeHarness(true);
    return Effect.gen(function* () {
      yield* seedReply("The build took 5 minutes and passed.");
      const service = yield* MentionedTimesCheck.MentionedTimesCheckService;
      yield* service.execute({ threadId, messageId });
      assert.strictEqual(harness.checkMentionedTimes.mock.calls.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });
});
