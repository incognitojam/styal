// @effect-diagnostics globalDate:off - Normalize git's ISO commit dates for the tracking issue.
import type { UpstreamCommit } from "./upstream-tracking-issue.ts";

type CommandRunner = (command: string, args: ReadonlyArray<string>) => string;

/** Walks integrations on upstream's first-parent chain without filtering by commit dates. */
export function scanUpstreamCommits(
  input: {
    readonly upstreamRepository: string;
    readonly upstreamRef: string;
    readonly mainRef: string;
    readonly previousHead?: string;
    readonly pullRequestsByMergeSha: ReadonlyMap<string, number>;
  },
  run: CommandRunner,
) {
  const git = (...args: Array<string>) => run("git", args).trim();
  const head = git("rev-parse", "--verify", `${input.upstreamRef}^{commit}`);
  const from = input.previousHead ?? git("merge-base", input.mainRef, head);
  if (git("merge-base", from, head) !== from) {
    throw new Error(
      "Upstream main no longer descends from the saved commit scan head. Review the history rewrite before resetting tracking state.",
    );
  }
  const onMain = new Set(git("rev-list", input.mainRef).split("\n"));
  const onUpstream = new Set(git("rev-list", head).split("\n"));
  const records = git(
    "log",
    "--first-parent",
    "--reverse",
    "--format=%H%x09%T%x09%P%x09%cI%x09%s",
    `${from}..${head}`,
  );
  const commits: Array<UpstreamCommit> = [];
  const emptyPullRequests: Array<number> = [];
  let previousSha = from;
  let previousTree = git("rev-parse", `${from}^{tree}`);
  let scanned = 0;
  let coveredByPullRequests = 0;
  for (const record of records.length === 0 ? [] : records.split("\n")) {
    const [sha, tree, parents, committedAt, ...subject] = record.split("\t");
    if (
      sha === undefined ||
      tree === undefined ||
      parents === undefined ||
      committedAt === undefined
    ) {
      throw new Error("Could not parse the upstream commit scan.");
    }
    if (parents.split(" ")[0] !== previousSha) {
      throw new Error(
        "The saved commit scan head is not on upstream main's first-parent chain. Review the history before resetting tracking state.",
      );
    }
    const empty = tree === previousTree;
    previousSha = sha;
    previousTree = tree;
    scanned += 1;
    const number = input.pullRequestsByMergeSha.get(sha);
    if (number !== undefined) {
      coveredByPullRequests += 1;
      if (empty && !onMain.has(sha)) emptyPullRequests.push(number);
      continue;
    }
    if (onMain.has(sha)) continue;

    // Rebase-merge siblings can have a PR association without being its merge SHA.
    // Suppress only when that PR is represented by this run's PR inventory.
    const pages = JSON.parse(
      run("gh", [
        "api",
        `repos/${input.upstreamRepository}/commits/${sha}/pulls?per_page=100`,
        "--paginate",
        "--slurp",
      ]),
    ) as ReadonlyArray<
      ReadonlyArray<{
        readonly number: number;
        readonly merged_at: string | null;
        readonly merge_commit_sha: string | null;
        readonly base: { readonly ref: string; readonly repo: { readonly full_name: string } };
      }>
    >;
    const associated = pages
      .flat()
      .flatMap((pr) =>
        pr.merged_at !== null &&
        pr.base.ref === "main" &&
        pr.base.repo.full_name === input.upstreamRepository &&
        pr.merge_commit_sha !== null &&
        onUpstream.has(pr.merge_commit_sha)
          ? [{ number: pr.number, mergedAt: pr.merged_at, sha: pr.merge_commit_sha }]
          : [],
      );
    if (associated.some((pr) => input.pullRequestsByMergeSha.has(pr.sha))) {
      coveredByPullRequests += 1;
      continue;
    }
    const missing = associated[0];
    if (missing !== undefined) {
      throw new Error(
        `The commit scan reaches upstream PR #${missing.number}, merged ${missing.mergedAt}, outside the PR inventory. Rerun tracking with --since-days wide enough to include that date (or retry if the PR just merged). The issue and saved commit scan head were not updated.`,
      );
    }
    const paths = git("diff", "--name-only", "--no-renames", `${sha}^1`, sha)
      .split("\n")
      .filter(Boolean);
    commits.push({
      sha,
      title: subject.join("\t"),
      committedAt: new Date(committedAt).toISOString(),
      areas: [...new Set(paths.map((path) => path.split("/").slice(0, 2).join("/")))].toSorted(),
      reviewReason: parents.includes(" ")
        ? "upstream merge outside the PR inventory; inspect the first-parent diff"
        : empty
          ? "empty upstream commit outside the PR inventory"
          : "upstream commit outside the PR inventory",
    });
  }
  return { from, head, scanned, coveredByPullRequests, commits, emptyPullRequests };
}
