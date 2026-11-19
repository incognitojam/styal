import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveMessagesTimelineRows, liveWorkEntryLabel } from "./MessagesTimeline.logic";

describe("long active tool groups", () => {
  it.each([false, true])(
    "confirms activity only after synchronization, live=%s",
    (isSynchronized) => {
      const runId = RunId.make("cached-waiting-run");
      const createdAt = "2026-10-12T00:00:00Z";
      const input = {
        timelineEntries: [
          {
            id: "cached-command",
            kind: "work",
            createdAt,
            entry: {
              id: "cached-command",
              createdAt,
              runId,
              label: "Tool call",
              command: "fixture-server",
              itemType: "command_execution",
              tone: "tool",
              toolLifecycleStatus: "inProgress",
            },
          },
        ],
        latestRun: { runId, status: "waiting", startedAt: createdAt, completedAt: null },
        isWorking: true,
        activityState: isSynchronized ? "live" : "unconfirmed",
        activeTurnStartedAt: createdAt,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      } as const;
      const rows = deriveMessagesTimelineRows(input);
      const live = rows.find((row) => row.kind === "work-live");
      expect(live).toMatchObject({ active: isSynchronized });
      expect(live && liveWorkEntryLabel(live.entry, undefined, live.active, live.unconfirmed)).toBe(
        isSynchronized ? "Running fixture-server" : "Last seen: Running fixture-server",
      );
      expect(rows.find((row) => row.kind === "working")?.unconfirmed === true).toBe(
        !isSynchronized,
      );
      expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
      const inactive = deriveMessagesTimelineRows({ ...input, activityState: "inactive" });
      expect(
        inactive.some(
          (row) => row.kind === "working" || row.kind === "work-live" || row.kind === "thinking",
        ),
      ).toBe(false);
      expect(inactive.some((row) => row.kind === "turn-fold")).toBe(false);
    },
  );
  it.each([false, true])(
    "preserves chronological order and the latest activity, expanded=%s",
    (expanded) => {
      const runId = RunId.make("long-active-run");
      const createdAt = "2026-10-12T00:00:00Z";
      const timelineEntries = Array.from({ length: 1_000 }, (_, index) => ({
        id: `work-entry-${index}`,
        kind: "work" as const,
        createdAt,
        entry: {
          id: `work-${index}`,
          createdAt,
          runId,
          label: `Tool ${index}`,
          tone: index % 2 === 0 ? ("thinking" as const) : ("tool" as const),
          itemType: index % 2 === 0 ? ("reasoning" as const) : ("command_execution" as const),
          ...(index % 2 === 0 ? { detail: `Thought ${index}` } : {}),
          toolLifecycleStatus: index === 999 ? ("inProgress" as const) : ("completed" as const),
        },
      }));
      const rows = deriveMessagesTimelineRows({
        timelineEntries,
        isWorking: true,
        runningRunId: runId,
        activeTurnStartedAt: createdAt,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        expandedWorkGroupIds: new Set(expanded ? ["work-group:work-entry-0"] : []),
      });
      const live = rows.find((row) => row.kind === "work-live");
      expect(live).toBeDefined();
      expect(live?.entry.id).toBe("work-999");
      expect(live && liveWorkEntryLabel(live.entry, undefined, live.active)).toContain("999");
      expect(live?.thought?.id).toBe("work-998");
      expect(live?.groupedEntries.map(({ id }) => id)).toEqual(
        timelineEntries.map(({ entry }) => entry.id),
      );
      expect(live?.groupId).toBe("work-group:work-entry-0");
      const details = rows.filter((row) => row.kind === "work");
      expect(details).toHaveLength(expanded ? 1 : 0);
      if (expanded) {
        expect(details[0]?.groupedEntries).toEqual(live?.groupedEntries);
      }
    },
  );
});
