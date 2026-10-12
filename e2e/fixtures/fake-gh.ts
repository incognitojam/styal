// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - standalone fake CLI with no workspace imports.
/**
 * A fake `gh` for e2e tests. It reports a signed-in github.com account with spare API
 * quota and no pull requests, and answers `issue list` and `issue view` from the issues in
 * `E2E_GH_ISSUES` (a JSON file in
 * `gh issue view --json` shape). Every call is appended to `E2E_GH_CALL_LOG`. Commands it
 * does not know exit 1, so a test that reaches one fails visibly instead of talking to
 * GitHub.
 */
import * as NodeFS from "node:fs";

interface FakeIssue {
  readonly number: number;
  readonly title: string;
  readonly state: "OPEN" | "CLOSED";
  readonly url: string;
  readonly body: string;
  readonly author: { readonly login: string };
  readonly comments: ReadonlyArray<{
    readonly author: { readonly login: string };
    readonly body: string;
  }>;
  readonly labels?: ReadonlyArray<{ readonly name: string }>;
}

const args = process.argv.slice(2);
const callLog = process.env.E2E_GH_CALL_LOG;
if (callLog) NodeFS.appendFileSync(callLog, `${JSON.stringify(args)}\n`, "utf8");

function issues(): ReadonlyArray<FakeIssue> {
  const path = process.env.E2E_GH_ISSUES;
  return path ? (JSON.parse(NodeFS.readFileSync(path, "utf8")) as ReadonlyArray<FakeIssue>) : [];
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`fake gh: ${message}\n`);
  process.exit(1);
}

const [command, subcommand] = args;

if (command === "--version") {
  process.stdout.write("gh version 2.81.0 (2026-01-01)\n");
} else if (command === "auth" && subcommand === "status") {
  print({
    hosts: {
      "github.com": [
        {
          state: "success",
          active: true,
          host: "github.com",
          login: "e2e-user",
          tokenSource: "oauth_token",
          gitProtocol: "https",
        },
      ],
    },
  });
} else if (command === "auth" && subcommand === "token") {
  process.stdout.write("gho_e2e_fake_token\n");
} else if (
  command === "api" &&
  subcommand === "graphql" &&
  args.some((arg) => arg.includes("rateLimit"))
) {
  print({
    data: { rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: "2026-01-01T00:00:00Z" } },
  });
} else if (command === "pr" && subcommand === "list") {
  print([]);
} else if (command === "issue" && subcommand === "list") {
  print(
    issues().map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.url,
      labels: issue.labels ?? [],
      updatedAt: "2026-10-01T00:00:00Z",
    })),
  );
} else if (command === "issue" && subcommand === "view") {
  const reference = args[2] ?? "";
  const number = Number(reference.replace(/^#/, "").split("/").at(-1));
  const issue = issues().find((candidate) => candidate.number === number);
  if (!issue) fail(`no issue ${reference}`);
  print(issue);
} else {
  fail(`unsupported command: ${args.join(" ")}`);
}
