import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import { Atom } from "effect/reactivity";
import { MessageSquareIcon } from "lucide-react";
import { use, useState } from "react";

import { cn } from "~/lib/utils";
import { environmentThreadShells } from "../../state/threads";
import { Button } from "../ui/button";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { startedThreadState } from "./startedThreads.logic";
import { TimelineRowCtx } from "./timelineRowContext";

const SHOWN = 5;

type LiveState = "working" | "needs-you" | "unavailable";

// One subscription per started thread's quiet shell, which the client already holds. A thread
// with no shell here (another machine not connected, or gone) is listed as not available.
const startedThreadsAtom = Atom.family((keys: string) => {
  let previous: ReadonlyArray<readonly [string, string | null, LiveState]> = [];
  return Atom.make((get) => {
    const next = keys
      .split("\n")
      .filter(Boolean)
      .flatMap((key): Array<readonly [string, string | null, LiveState]> => {
        const shell = get(environmentThreadShells.quietThreadShellAtom(parseThreadKey(key)));
        if (shell === null) return [[key, null, "unavailable"]];
        const state = startedThreadState(shell);
        return state === null ? [] : [[key, shell.title, state]];
      });
    const same =
      next.length === previous.length &&
      next.every((entry, index) => entry.every((part, at) => part === previous[index]![at]));
    if (!same) previous = next;
    return previous;
  });
});

/** The threads one turn of the project chat started that still work or wait on you. */
export function StartedThreadsTimelineRow({
  row,
}: {
  row: Extract<MessagesTimelineRow, { kind: "started-threads" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const [expanded, setExpanded] = useState(false);
  const keyed = new Map(
    row.threads.map((thread) => [
      threadKey(
        scopeThreadRef(thread.environmentId ?? ctx.activeThreadEnvironmentId, thread.threadId),
      ),
      thread,
    ]),
  );
  const live = useAtomValue(startedThreadsAtom([...keyed.keys()].join("\n")));
  const shown = expanded ? live : live.slice(0, SHOWN);
  const started = row.threads.length;
  const going = live.filter(([, , state]) => state !== "unavailable").length;
  return (
    <div
      data-started-threads={started}
      className="flex min-w-0 flex-col rounded-lg border border-border/60 py-1 text-sm"
    >
      <div className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-muted-foreground [&_svg]:size-3.5">
        <MessageSquareIcon aria-hidden className="shrink-0" />
        <span className="min-w-0 truncate">
          Started {started} {started === 1 ? "thread" : "threads"}
          {live.length === 0
            ? started === 1
              ? " · finished"
              : " · all finished"
            : going > 0 && going < started
              ? ` · ${going} still going`
              : ""}
        </span>
      </div>
      {shown.map(([key, title, state]) => (
        <button
          key={key}
          type="button"
          className="flex min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/40"
          onClick={() => {
            const ref = parseThreadKey(key);
            ctx.onOpenThread(ref.threadId, ref.environmentId);
          }}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              state === "needs-you" ? "bg-warning" : "bg-muted-foreground/60",
            )}
          />
          <span className="min-w-0 flex-1 truncate text-foreground">
            {title ?? keyed.get(key)?.title ?? "Started thread"}
          </span>
          <span
            className={cn(
              "shrink-0 text-xs",
              state === "needs-you" ? "text-warning-foreground" : "text-muted-foreground",
            )}
          >
            {state === "needs-you"
              ? "Needs you"
              : state === "working"
                ? "Working"
                : "Not available"}
          </span>
        </button>
      ))}
      {live.length > SHOWN ? (
        <Button
          size="xs"
          variant="ghost-muted"
          className="mx-1.5 self-start"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : `Show ${live.length - SHOWN} more`}
        </Button>
      ) : null}
    </div>
  );
}
