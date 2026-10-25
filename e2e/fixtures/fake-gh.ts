// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - standalone fake CLI with no workspace imports.
/**
 * A fake `gh` that reports a signed-in github.com account and a fake token; GitHub data comes
 * from e2e/support/fake-github-api.ts. Calls are appended to `E2E_GH_CALL_LOG`. Unknown commands
 * exit 1 so a test that reaches one fails visibly instead of talking to GitHub.
 */
import * as NodeFS from "node:fs";

const args = process.argv.slice(2);
const callLog = process.env.E2E_GH_CALL_LOG;
if (callLog) NodeFS.appendFileSync(callLog, `${JSON.stringify(args)}\n`, "utf8");

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
} else {
  fail(`unsupported command: ${args.join(" ")}`);
}
