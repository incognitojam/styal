import { useAtomValue } from "@effect/atom-react";
import { createPullRequestAnnouncementTracker } from "@t3tools/client-runtime/pull-request-announcements";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { announcerPlayer, getAnnouncerPlayback, subscribeAnnouncerPlayback } from "../announcer";
import { useClientSettings } from "../hooks/useSettings";
import { environmentSummaries } from "../state/presentation";
import { environmentShell } from "../state/shell";
import { hasNotificationSound } from "../threadNotifications";
import { toastManager } from "./ui/toast";

const sourcesAtom = Atom.make((get) =>
  get(environmentSummaries.environmentIdsAtom).map((environmentId) => {
    const shell = get(environmentShell.stateValueAtom(environmentId));
    return {
      environmentId,
      live: shell.status === "live",
      links: Option.isSome(shell.snapshot)
        ? shell.snapshot.value.threads.flatMap((thread) =>
            thread.archivedAt === null && thread.lineage.relationshipToParent !== "subagent"
              ? (thread.pullRequests ?? [])
              : [],
          )
        : [],
    };
  }),
).pipe(Atom.withLabel("web-pull-request-announcer-sources"));

function LiveAnnouncements() {
  const sources = useAtomValue(sourcesAtom);
  const tracker = useRef(createPullRequestAnnouncementTracker());

  useEffect(() => {
    const { announcements, current } = tracker.current(sources);
    for (const announcement of announcements) announcerPlayer.announce(announcement);
    announcerPlayer.reconcile(current);
  }, [sources]);

  // Turning the announcer or notification sounds off unmounts this and silences playback.
  useEffect(() => () => announcerPlayer.stop(), []);
  return null;
}

/** Playback lives above routes so navigation does not interrupt live announcements. */
export function PullRequestAnnouncerCoordinator() {
  const enabled = useClientSettings(
    (settings) =>
      settings.pullRequestAnnouncerEnabled && hasNotificationSound(settings.notificationMode),
  );
  const playback = useSyncExternalStore(subscribeAnnouncerPlayback, getAnnouncerPlayback);
  const toastId = useRef<ReturnType<typeof toastManager.add> | null>(null);

  useEffect(() => {
    if (!playback.playing) {
      if (toastId.current !== null) toastManager.close(toastId.current);
      toastId.current = null;
      if (playback.error)
        toastManager.add({ title: "PR announcements", description: playback.error, type: "error" });
      return;
    }
    const options = {
      title: "PR announcement",
      description: playback.current?.text,
      timeout: 0,
      actionProps: { children: "Stop", onClick: () => announcerPlayer.stop() },
      data: { hideCopyButton: true },
    };
    if (toastId.current === null) toastId.current = toastManager.add(options);
    else toastManager.update(toastId.current, options);
  }, [playback]);

  useEffect(
    () => () => {
      if (toastId.current !== null) toastManager.close(toastId.current);
    },
    [],
  );

  return enabled ? <LiveAnnouncements /> : null;
}
