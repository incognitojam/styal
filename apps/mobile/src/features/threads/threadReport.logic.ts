type ReportLike = {
  readonly message: { readonly id: string };
  readonly state: string;
  readonly answer?: unknown;
};

/**
 * An answer or a dismissal is on record, from here or anywhere else: back to the list. A reply
 * to a version that was replaced while it was typed counts too.
 */
export function reportFinished(report: ReportLike): boolean {
  return report.answer !== undefined || report.state === "answered" || report.state === "dismissed";
}

/**
 * Where the opened report stands. One older than the loaded history is on its way while that
 * history loads or can still load; it is gone only once the whole thread is loaded without it.
 */
export function findOpenedReport<R extends ReportLike>(
  reports: readonly R[],
  id: string,
  thread: {
    readonly ready: boolean;
    readonly history: {
      readonly loading: boolean;
      readonly hasMoreHistory: boolean;
      readonly error: unknown;
    };
  },
): { readonly kind: "found"; readonly report: R } | { readonly kind: "loading" | "gone" } {
  const report = reports.find((entry) => entry.message.id === id);
  if (report !== undefined) return { kind: "found", report };
  if (!thread.ready || thread.history.loading) return { kind: "loading" };
  return thread.history.hasMoreHistory && thread.history.error === null
    ? { kind: "loading" }
    : { kind: "gone" };
}

/** The report's markdown without a leading heading that repeats the title its header shows. */
export function reportBodyMarkdown(markdown: string, title: string): string {
  const heading = /^\s*#{1,6}[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(markdown);
  return heading?.[1]?.trim() === title.trim()
    ? markdown.slice(heading[0].length).trimStart()
    : markdown;
}
