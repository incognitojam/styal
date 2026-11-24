import type { RunId } from "@t3tools/contracts";

export function restartOutages<Entry>(
  entries: Iterable<Entry>,
  describe: (entry: Entry) => { runId: RunId | null; startedAt: string; endedAt: string },
): ReadonlyArray<readonly [number, number]> {
  let previousRun: RunId | null = null;
  let previousEnd: number | null = null;
  const outages: Array<readonly [number, number]> = [];
  for (const entry of entries) {
    const current = describe(entry);
    const start = Date.parse(current.startedAt);
    if (
      previousRun !== null &&
      current.runId !== previousRun &&
      previousEnd !== null &&
      Number.isFinite(start) &&
      start > previousEnd
    )
      outages.push([previousEnd, start]);
    previousRun = current.runId;
    const end = Date.parse(current.endedAt);
    if (Number.isFinite(end)) previousEnd = previousEnd === null ? end : Math.max(previousEnd, end);
  }
  return outages;
}

export function restartDowntimeMs(
  outages: ReadonlyArray<readonly [number, number]>,
  from = Number.NEGATIVE_INFINITY,
  to = Number.POSITIVE_INFINITY,
): number {
  return outages.reduce(
    (total, [start, end]) => total + Math.max(0, Math.min(end, to) - Math.max(start, from)),
    0,
  );
}
