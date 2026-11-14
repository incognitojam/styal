export type Request = <T>(method: string, path: string, body?: object) => Promise<T>;
export type CreatedIssue = {
  number: number;
  title: string;
  html_url: string;
  user: { login: string } | null;
};

export function inertText(text: string, limit = 500) {
  return "`" + text.replaceAll("`", "'").replace(/\s+/g, " ").trim().slice(0, limit) + "`";
}

export async function openIssues<T extends { number: number; pull_request?: unknown }>(
  request: Request,
  repo: string,
  label: string,
): Promise<T[]> {
  const issues: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await request<T[]>(
      "GET",
      `/repos/${repo}/issues?state=open&labels=${label}&per_page=100&page=${page}`,
    );
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < 100) return issues;
  }
}
export async function ensureLabels(
  request: Request,
  root: string,
  labels: { name: string; color: string; description: string }[],
) {
  for (const label of labels) {
    // POST is idempotent here only when the label already exists (422).
    try {
      await request("GET", `${root}/labels/${label.name}`);
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      try {
        await request("POST", `${root}/labels`, label);
      } catch (creationError) {
        if ((creationError as { status?: number }).status !== 422) throw creationError;
        await request("GET", `${root}/labels/${label.name}`);
      }
    }
  }
}
export async function commentOnce(
  request: Request,
  root: string,
  number: number,
  body: string,
  marker?: string,
) {
  for (let page = 1; ; page++) {
    const comments = await request<{ body: string }[]>(
      "GET",
      `${root}/issues/${number}/comments?per_page=100&page=${page}`,
    );
    if (
      comments.some((comment) => (marker ? comment.body.includes(marker) : comment.body === body))
    )
      return;
    if (comments.length < 100) break;
  }
  await request("POST", `${root}/issues/${number}/comments`, { body });
}
export async function announceIssue(
  issue: CreatedIssue,
  announce?: (issue: CreatedIssue) => Promise<void>,
  warn?: (message: string) => void,
) {
  try {
    await announce?.(issue);
  } catch {
    warn?.("Discord issue announcement could not be delivered.");
  }
}
