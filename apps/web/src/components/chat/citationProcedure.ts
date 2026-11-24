import { useAtomValue } from "@effect/atom-react";
import { type AtomCommandSuccess, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { Atom, type AtomRegistry } from "effect/reactivity";
import type { TimelineEntry } from "../../session-logic";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { toastManager } from "../ui/toast";
import type { AssistantCitationRequest } from "./AssistantCitationSource";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

/** Whether the cited response is in the loaded history, after paging toward it. */
export type CitedHistory =
  | { readonly _tag: "loading" }
  | { readonly _tag: "found" }
  | { readonly _tag: "failed" };

export type CitationPhase =
  | { readonly _tag: "loading" }
  | { readonly _tag: "expanding" }
  | { readonly _tag: "ready"; readonly rowId: string }
  | { readonly _tag: "failed" };

export interface CitedThreadSnapshot {
  readonly message: "assistant" | "other" | null;
  readonly hasMoreHistory: boolean;
  readonly loadFailed?: true;
  readonly historyCursor?: string | null;
}

export type CitedHistoryOutcome =
  | { readonly _tag: "found" }
  | { readonly _tag: "failed"; readonly title: string; readonly description: string }
  | { readonly _tag: "aborted" };

type HistoryPageResult = AtomCommandSuccess<
  Awaited<ReturnType<typeof threadEnvironment.loadEarlierHistory.run>>
>;

const MAX_CITATION_PAGES = 20;

const COULD_NOT_LOAD = {
  _tag: "failed",
  title: "Could not load the cited response",
  description:
    "Load earlier turns, then click the citation to try again. Your saved quote is unchanged.",
} as const;

const UNAVAILABLE = {
  _tag: "failed",
  title: "The cited response is unavailable",
  description: "It may have been removed. The selected text is still saved in your citation.",
} as const;

/**
 * Pages history toward the cited message until it is loaded, the thread runs
 * out of history, or loading fails. `readThread` resolves once the thread
 * detail is settled (loaded and no history page in flight), or with null when
 * the signal aborts.
 */
export async function loadCitedHistory(input: {
  readonly signal: AbortSignal;
  readonly readThread: () => Promise<CitedThreadSnapshot | null>;
  readonly loadThrough: () => Promise<HistoryPageResult>;
  readonly maxPages?: number;
}): Promise<CitedHistoryOutcome> {
  let previousCursor: string | null | undefined;
  for (let attempts = 0; ; attempts += 1) {
    const thread = await input.readThread();
    if (thread === null || input.signal.aborted) return { _tag: "aborted" };
    if (thread.loadFailed) return COULD_NOT_LOAD;
    if (thread.message === "assistant") return { _tag: "found" };
    if (thread.message === "other") {
      return {
        _tag: "failed",
        title: "The citation does not refer to an assistant response",
        description: "The selected text is still saved in your citation.",
      };
    }
    if (!thread.hasMoreHistory) return UNAVAILABLE;
    if (attempts >= (input.maxPages ?? MAX_CITATION_PAGES)) return COULD_NOT_LOAD;
    if (
      attempts > 0 &&
      thread.historyCursor !== undefined &&
      thread.historyCursor === previousCursor
    )
      return COULD_NOT_LOAD;
    previousCursor = thread.historyCursor;
    const result = await input.loadThrough();
    if (input.signal.aborted) return { _tag: "aborted" };
    if (result._tag === "error") return COULD_NOT_LOAD;
    // A noop page means the store has nothing older to load (no cursor, or the
    // thread is gone), so re-reading would only spin on the same snapshot.
    if (result._tag === "noop") return UNAVAILABLE;
  }
}

export async function loadReportHistory(
  input: Parameters<typeof loadCitedHistory>[0],
): Promise<CitedHistoryOutcome> {
  const outcome = await loadCitedHistory({ ...input, maxPages: Number.POSITIVE_INFINITY });
  return outcome._tag === "failed"
    ? {
        _tag: "failed",
        title: "Could not open report",
        description:
          outcome === UNAVAILABLE
            ? "This report is no longer available."
            : "History could not be loaded. Click the report to try again.",
      }
    : outcome;
}

/** Where the citation stands for the rows the timeline currently shows. */
export function resolveCitationPhase(input: {
  readonly history: CitedHistory;
  readonly messageId: string;
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
}): CitationPhase {
  if (input.history._tag === "failed") return { _tag: "failed" };
  const source = input.entries.find(
    (entry) => entry.kind === "message" && entry.message.id === input.messageId,
  );
  // The history store can hold the message a render before the entries do.
  if (!source) return { _tag: "loading" };
  if (source.kind !== "message" || source.message.role !== "assistant") return { _tag: "failed" };
  const row = input.rows.find(
    (candidate) => candidate.kind === "message" && candidate.message.id === input.messageId,
  );
  if (row) return { _tag: "ready", rowId: row.id };
  return { _tag: "expanding" };
}

type ThreadDetail<K extends keyof typeof environmentThreadDetails> = Atom.Type<
  ReturnType<(typeof environmentThreadDetails)[K]>
>;

/**
 * The cited thread as `loadCitedHistory` reads it, or null while it is still
 * settling. A thread that failed to load before any projection arrived counts
 * as settled, so the citation fails instead of waiting on the stream's retries.
 */
export function citedThreadSnapshot(input: {
  readonly thread: ThreadDetail<"quietThreadAtom">;
  readonly history: ThreadDetail<"historyAtom">;
  readonly status: ThreadDetail<"statusAtom">;
  readonly error: ThreadDetail<"errorAtom">;
  readonly messageId: string;
}): CitedThreadSnapshot | null {
  if (input.history.loading) return null;
  if (input.thread === null) {
    if (input.status === "deleted") return { message: null, hasMoreHistory: false };
    return input.error === null ? null : { message: null, hasMoreHistory: false, loadFailed: true };
  }
  // Older pages merge into the visible turn items, not the message list.
  const item = input.thread.projection.visibleTurnItems.find(
    (row) =>
      (row.item.type === "assistant_message" || row.item.type === "user_message") &&
      row.item.messageId === input.messageId,
  )?.item;
  return {
    message: item === undefined ? null : item.type === "assistant_message" ? "assistant" : "other",
    hasMoreHistory: input.history.hasMoreHistory,
    historyCursor: input.history.historyCursor,
  };
}

interface MessageHistoryRequest {
  readonly kind?: "citation" | "report";
  readonly key: string;
  readonly environmentId: AssistantCitationRequest["citation"]["environmentId"];
  readonly threadId: AssistantCitationRequest["citation"]["threadId"];
  readonly messageId: AssistantCitationRequest["citation"]["messageId"];
}

function waitForSettledThread(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<CitedThreadSnapshot | null>,
  signal: AbortSignal,
): Promise<CitedThreadSnapshot | null> {
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    let settled = false;
    const finish = (value: CitedThreadSnapshot | null) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(null);
    const check = (value: CitedThreadSnapshot | null) => {
      if (value !== null) finish(value);
    };
    signal.addEventListener("abort", onAbort);
    unsubscribe = registry.subscribe(atom, check);
    if (settled) unsubscribe();
    else check(registry.get(atom));
  });
}

/**
 * The citation procedure for one activation (the location key). Mounting it
 * starts paging; leaving the location unmounts it and the finalizer stops it.
 * Plain-object keys compare structurally, so one activation is one procedure.
 */
const messageHistoryAtom = Atom.family(
  ({ key, environmentId, threadId, messageId, kind }: MessageHistoryRequest) => {
    const ref = { environmentId, threadId };
    const threadAtom = environmentThreadDetails.quietThreadAtom(ref);
    const historyAtom = environmentThreadDetails.historyAtom(ref);
    const statusAtom = environmentThreadDetails.statusAtom(ref);
    const errorAtom = environmentThreadDetails.errorAtom(ref);
    const settledThreadAtom = Atom.make((get) =>
      citedThreadSnapshot({
        thread: get(threadAtom),
        history: get(historyAtom),
        status: get(statusAtom),
        error: get(errorAtom),
        messageId,
      }),
    );
    return Atom.make((get): CitedHistory => {
      const controller = new AbortController();
      const loadingToast =
        kind === "report" && get.registry.get(settledThreadAtom)?.message !== "assistant"
          ? toastManager.add({ type: "info", title: "Opening report…", timeout: 0 })
          : undefined;
      get.addFinalizer(() => {
        controller.abort();
        if (loadingToast) toastManager.close(loadingToast);
      });
      const load = kind === "report" ? loadReportHistory : loadCitedHistory;
      void load({
        signal: controller.signal,
        readThread: () => waitForSettledThread(get.registry, settledThreadAtom, controller.signal),
        loadThrough: async () => {
          const result = await runAtomCommand(
            get.registry,
            threadEnvironment.loadEarlierHistory,
            { environmentId, input: { threadId, throughEntryId: messageId } },
            { label: "load cited thread history", reportFailure: false },
          );
          return result._tag === "Success"
            ? result.value
            : { _tag: "error", message: "Could not load history." };
        },
      }).then((outcome) => {
        if (loadingToast) toastManager.close(loadingToast);
        if (outcome._tag === "aborted") return;
        if (outcome._tag === "failed") {
          toastManager.add({
            type: "warning",
            title: outcome.title,
            description: outcome.description,
          });
        }
        get.setSelf({ _tag: outcome._tag });
      });
      return { _tag: "loading" };
    }).pipe(Atom.withLabel(`message-navigation:history:${key}`));
  },
);

const NO_CITED_HISTORY_ATOM = Atom.make<CitedHistory>({ _tag: "loading" });

export function useMessageHistory(request: MessageHistoryRequest | null): CitedHistory {
  return useAtomValue(request === null ? NO_CITED_HISTORY_ATOM : messageHistoryAtom(request));
}

export function useCitedHistory(request: AssistantCitationRequest | null): CitedHistory {
  return useMessageHistory(
    request === null
      ? null
      : {
          key: request.key,
          environmentId: request.citation.environmentId,
          threadId: request.citation.threadId,
          messageId: request.citation.messageId,
        },
  );
}
