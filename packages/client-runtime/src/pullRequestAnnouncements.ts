import type { ThreadPullRequestLink, ThreadPullRequestSnapshot } from "@t3tools/contracts";
import { normalizeThreadPullRequestKey } from "@t3tools/shared/threadPullRequests";

/** What the announcer can say live, in the order the settings preview steps through them. */
export const PULL_REQUEST_ANNOUNCEMENT_KINDS = [
  "ready",
  "arrived",
  "ci-failure",
  "merge-conflict",
  "stack-delayed",
  "changes-requested",
  "cancelled",
] as const;
export type PullRequestAnnouncementKind = (typeof PULL_REQUEST_ANNOUNCEMENT_KINDS)[number];

export interface PullRequestAnnouncement {
  readonly key: string;
  readonly number: number;
  readonly kind: PullRequestAnnouncementKind;
}

interface PullRequestAnnouncementSource {
  readonly environmentId: string;
  readonly live: boolean;
  readonly links: ReadonlyArray<ThreadPullRequestLink>;
}

/** The written form of an announcement, shown while it plays; the recording reads the number digit by digit. */
export function pullRequestAnnouncementText(number: number, kind: PullRequestAnnouncementKind) {
  const prefix =
    kind === "cancelled"
      ? `We are sorry to announce that pull request #${number}`
      : `Pull request #${number}`;
  const endings = {
    ready: "is ready to depart. It is awaiting a member of train crew.",
    arrived: "has arrived.",
    "ci-failure": "is delayed. This is due to a CI failure.",
    "merge-conflict": "is delayed. This is due to a merge conflict.",
    "stack-delayed": "is delayed. This is due to a slower running train ahead.",
    "changes-requested": "is being held at a red signal.",
    cancelled: "has been cancelled.",
  } satisfies Record<PullRequestAnnouncementKind, string>;
  return `${prefix} ${endings[kind]}`;
}

function keyOf(link: ThreadPullRequestLink) {
  const key = normalizeThreadPullRequestKey(link);
  return JSON.stringify([key.host, key.repository, key.number]);
}

interface Observation {
  readonly snapshot: ThreadPullRequestSnapshot;
  readonly kind: PullRequestAnnouncementKind | null;
}

/** The single announcement a PR's current state warrants, most decisive first. */
function announcementKind(
  snapshot: ThreadPullRequestSnapshot,
  blockedByStack: boolean,
): PullRequestAnnouncementKind | null {
  if (snapshot.state === "merged") return "arrived";
  if (snapshot.state === "closed") return "cancelled";
  if (snapshot.isDraft) return null;
  if (snapshot.mergeability === "conflicting") return "merge-conflict";
  if (snapshot.checksState === "failing") return "ci-failure";
  if (snapshot.reviewDecision === "changes-requested") return "changes-requested";
  if (snapshot.checksState !== "passing") return null;
  if (blockedByStack) return "stack-delayed";
  // An armed auto-merge or a queued merge needs nobody; its arrival is the news.
  return snapshot.autoMergeEnabled === true || snapshot.inMergeQueue === true ? null : "ready";
}

function observe(link: ThreadPullRequestLink, previous?: Observation): Observation | null {
  if (link.snapshot === null) return null;
  const incoming = link.snapshot;
  // Cheap or temporarily incomplete host reads must not clear a known blocker.
  const snapshot = {
    ...incoming,
    checksState: incoming.checksState ?? previous?.snapshot.checksState,
    reviewDecision:
      incoming.reviewDecision === undefined
        ? previous?.snapshot.reviewDecision
        : incoming.reviewDecision,
    mergeability:
      incoming.mergeability === undefined || incoming.mergeability === "unknown"
        ? previous?.snapshot.mergeability
        : incoming.mergeability,
  };
  const layer = link.stack?.layers.findIndex((item) => item.number === link.number) ?? -1;
  const blockedByStack =
    layer > 0 && link.stack!.layers.slice(0, layer).some((item) => item.state === "open");
  return { snapshot, kind: announcementKind(snapshot, blockedByStack) };
}

function isNewTransition(previous: Observation, next: Observation) {
  if (previous.kind === next.kind || next.kind === null) return false;
  switch (next.kind) {
    case "arrived":
    case "cancelled":
      return previous.snapshot.state !== next.snapshot.state;
    case "ci-failure":
      return (
        previous.snapshot.checksState !== undefined && previous.snapshot.checksState !== "failing"
      );
    case "merge-conflict":
      return (
        previous.snapshot.mergeability !== undefined &&
        previous.snapshot.mergeability !== "unknown" &&
        previous.snapshot.mergeability !== "conflicting"
      );
    case "changes-requested":
      return (
        previous.snapshot.reviewDecision !== undefined &&
        previous.snapshot.reviewDecision !== "changes-requested"
      );
    case "stack-delayed":
      return true;
    // Waiting on a person, whether checks just passed or a blocker just cleared.
    case "ready":
      return previous.snapshot.checksState !== undefined;
    default:
      return false;
  }
}

/** Compare live snapshots without polling, baseline new links/reconnections, and deduplicate hosts. */
export function createPullRequestAnnouncementTracker() {
  let previous = new Map<string, Observation>();
  let membership = new Map<string, Set<string>>();

  return (sources: ReadonlyArray<PullRequestAnnouncementSource>) => {
    const latest = new Map<string, ThreadPullRequestLink>();
    const nextMembership = new Map<string, Set<string>>();
    const continuous = new Set<string>();
    for (const source of sources) {
      if (!source.live) continue;
      const keys = new Set<string>();
      for (const link of source.links) {
        if (link.source === "stack-dismissed" || link.snapshot === null) continue;
        const key = keyOf(link);
        keys.add(key);
        if (membership.get(source.environmentId)?.has(key)) continuous.add(key);
        const known = latest.get(key);
        if (!known || link.snapshot.syncedAt > known.snapshot!.syncedAt) latest.set(key, link);
      }
      nextMembership.set(source.environmentId, keys);
    }

    const next = new Map<string, Observation>();
    const announcements: PullRequestAnnouncement[] = [];
    const current = new Map<string, PullRequestAnnouncementKind | null>();
    for (const [key, link] of latest) {
      const before = previous.get(key);
      // Another environment may still carry an older copy of the same PR.
      const observation =
        before && link.snapshot!.syncedAt < before.snapshot.syncedAt
          ? before
          : observe(link, before);
      if (!observation) continue;
      next.set(key, observation);
      current.set(key, observation.kind);
      if (before && continuous.has(key) && isNewTransition(before, observation)) {
        announcements.push({ key, number: link.number, kind: observation.kind! });
      }
    }
    previous = next;
    membership = nextMembership;
    return { announcements, current };
  };
}
