type StackReport = {
  readonly state: string;
  readonly message: {
    readonly id: string;
    readonly createdAt: string;
    readonly report?: { readonly key: string } | undefined;
  };
};

const topic = (report: StackReport) => report.message.report!.key;

/**
 * The open reports, each topic where its first version arrived, so a new version keeps its place.
 * Topics put off with Later follow, in the order they were put off.
 */
export function reportStackOrder<R extends StackReport>(
  reports: readonly R[],
  later: readonly string[],
): R[] {
  const arrived = new Map<string, string>();
  for (const report of reports) {
    const first = arrived.get(topic(report));
    if (first === undefined || report.message.createdAt < first)
      arrived.set(topic(report), report.message.createdAt);
  }
  const deferred = (report: R) => later.indexOf(topic(report));
  return reports
    .filter((report) => report.state === "open")
    .toSorted((a, b) => {
      const laterA = deferred(a);
      const laterB = deferred(b);
      if (laterA !== laterB) return laterA === -1 ? -1 : laterB === -1 ? 1 : laterA - laterB;
      return arrived.get(topic(a))!.localeCompare(arrived.get(topic(b))!);
    });
}

/** The report on top: the topic being read while it is still open, otherwise the first. */
export function reportStackTop<R extends StackReport>(order: readonly R[], current: string | null) {
  return order.find((report) => topic(report) === current) ?? order[0] ?? null;
}

/** The topic to read once `key` leaves the top: the one after it, or else the first other one. */
export function reportAfter(order: readonly StackReport[], key: string): string | null {
  const index = order.findIndex((report) => topic(report) === key);
  const next = order[index + 1] ?? order.find((report) => topic(report) !== key);
  return next === undefined || topic(next) === key ? null : topic(next);
}

/** `later` with `key` moved to its end. */
export function deferReport(later: readonly string[], key: string): string[] {
  return [...later.filter((entry) => entry !== key), key];
}

/** How many sheets show under the top one: none on the last, then one, two, at most three. */
export function reportStackEdges(remaining: number) {
  return remaining <= 1 ? 0 : remaining <= 3 ? 1 : remaining <= 8 ? 2 : 3;
}
