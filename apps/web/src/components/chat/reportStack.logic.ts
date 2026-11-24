type StackReport = {
  readonly state: string;
  readonly message: {
    readonly id: string;
    readonly createdAt: string;
    readonly report?: { readonly key: string; readonly blocking?: boolean | undefined } | undefined;
  };
};

const topic = (report: StackReport) => report.message.report!.key;

/**
 * The open reports: blocking ones first, then each topic where its first version arrived, so a new
 * version keeps its place. Topics put off with Later follow, in the order they were put off.
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
      const blockingA = a.message.report!.blocking === true;
      if (blockingA !== (b.message.report!.blocking === true)) return blockingA ? -1 : 1;
      return arrived.get(topic(a))!.localeCompare(arrived.get(topic(b))!);
    });
}

export type ReportStackView<R> = {
  readonly open: boolean;
  readonly all: boolean;
  /** The topic on screen. New arrivals join the pile and never take its place. */
  readonly current: string | null;
  readonly later: readonly string[];
  /** The report just answered, lifting off the top; the next one takes no input until it lands. */
  readonly leaving: R | null;
  /** Numbers each lift-off, so a stale landing cannot end a newer one, even of the same report. */
  readonly lift: number;
  readonly answered: string | null;
};

export const closedReportStack: ReportStackView<never> = {
  open: false,
  all: false,
  current: null,
  later: [],
  leaving: null,
  lift: 0,
  answered: null,
};

/**
 * The report on top. While the stack is open it is the topic being read, for as long as that is
 * open; closed, the pile shows the first in order.
 */
export function reportStackTop<R extends StackReport>(
  order: readonly R[],
  view: Pick<ReportStackView<R>, "open" | "current">,
) {
  return (
    (view.open ? order.find((report) => topic(report) === view.current) : undefined) ??
    order[0] ??
    null
  );
}

export function openReportStack<R extends StackReport>(
  view: ReportStackView<R>,
  order: readonly R[],
): ReportStackView<R> {
  const top = order[0];
  return { ...view, open: true, all: false, current: top ? topic(top) : null, answered: null };
}

export function closeReportStack<R>(view: ReportStackView<R>): ReportStackView<R> {
  return { ...view, open: false, all: false, current: null, leaving: null, answered: null };
}

/** Answers the top report and moves on, or null while the last answer is still lifting off. */
export function answerReportStack<R extends StackReport>(
  view: ReportStackView<R>,
  order: readonly R[],
  report: R,
  answer: string,
  motion: boolean,
): ReportStackView<R> | null {
  if (view.leaving !== null) return null;
  return {
    ...view,
    current: reportAfter(order, topic(report)),
    leaving: motion ? report : null,
    lift: motion ? view.lift + 1 : view.lift,
    answered: answer,
  };
}

/** Puts the top report at the bottom of the pile, or null while an answer is still lifting off. */
export function deferReportStack<R extends StackReport>(
  view: ReportStackView<R>,
  order: readonly R[],
  report: R,
): ReportStackView<R> | null {
  if (view.leaving !== null) return null;
  const key = topic(report);
  return {
    ...view,
    current: reportAfter(order, key),
    later: deferReport(view.later, key),
    answered: null,
  };
}

/** Lift-off `lift` has landed; a stale landing leaves a newer lift in place. */
export function landReportStack<R>(view: ReportStackView<R>, lift: number): ReportStackView<R> {
  return view.leaving !== null && view.lift === lift ? { ...view, leaving: null } : view;
}

/** What a key does on the open stack: one press per report, nothing while a sheet lifts off. */
export function reportStackKey(
  event: { readonly key: string; readonly repeat: boolean },
  view: Pick<ReportStackView<unknown>, "all" | "leaving">,
  answers: readonly string[],
):
  | { readonly kind: "close" | "back" | "later" }
  | { readonly kind: "answer"; readonly answer: string }
  | null {
  if (event.key === "Escape") return { kind: view.all ? "back" : "close" };
  if (event.repeat || view.all || view.leaving !== null) return null;
  if (event.key === "ArrowRight") return { kind: "later" };
  const answer = /^[1-4]$/.test(event.key) ? answers[Number(event.key) - 1] : undefined;
  return answer === undefined ? null : { kind: "answer", answer };
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
