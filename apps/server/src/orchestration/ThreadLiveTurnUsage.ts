/**
 * ThreadLiveTurnUsageService - in-memory usage of each thread's running turn,
 * so the thread's total moves while the turn works instead of only when it
 * finishes.
 *
 * Ingestion records each `turn.usage.updated` here and the shell query adds it
 * to the stored total at mapping time, like ThreadPlanProgressService: no
 * persistence, and no push of its own. Updates reach clients with the next
 * shell refetch, which a running turn's own activity soon causes. The entry is
 * cleared once the turn's usage record is appended, so the stored total takes
 * over without counting the turn twice.
 *
 * @module ThreadLiveTurnUsageService
 */
import type { ThreadTokenUsage, TurnTokenUsage } from "@t3tools/contracts";
import { withLiveTurnUsage } from "@t3tools/shared/turnUsage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class ThreadLiveTurnUsageService extends Context.Service<
  ThreadLiveTurnUsageService,
  {
    readonly recordLiveTurnUsage: (threadId: string, turnId: string, usage: TurnTokenUsage) => void;

    /** Clears the thread's entry, or only `turnId`'s when given. */
    readonly clearLiveTurnUsage: (threadId: string, turnId?: string) => void;

    /** The thread's stored total with its running turn's usage so far. */
    readonly withLiveTurnUsage: (
      threadId: string,
      stored: ThreadTokenUsage | null,
    ) => ThreadTokenUsage | null;
  }
>()("@styal/cli/orchestration/ThreadLiveTurnUsage/ThreadLiveTurnUsageService") {}

function make(): ThreadLiveTurnUsageService["Service"] {
  const liveByThreadId = new Map<string, { turnId: string; usage: TurnTokenUsage }>();

  return {
    recordLiveTurnUsage: (threadId, turnId, usage) => {
      liveByThreadId.set(threadId, { turnId, usage });
    },

    clearLiveTurnUsage: (threadId, turnId) => {
      if (turnId === undefined || liveByThreadId.get(threadId)?.turnId === turnId) {
        liveByThreadId.delete(threadId);
      }
    },

    withLiveTurnUsage: (threadId, stored) => {
      const live = liveByThreadId.get(threadId);
      return live ? withLiveTurnUsage(stored, live.usage) : stored;
    },
  };
}

export const layer = Layer.effect(ThreadLiveTurnUsageService, Effect.sync(make));
