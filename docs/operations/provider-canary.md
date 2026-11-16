# Provider canary

Automatic provider updates install only a version listed in `autoUpdates` in
the matching compatibility policy of
[`model-manifest.json`](../../apps/server/src/provider/model-manifest.json).
Each entry names the provider version, the npm package that was installed, and
`styal`: the published styal build it was verified on. A server takes an entry
when its code contains that build: a later nightly, a stable release of a later
version, or the build itself. A stable release is rebuilt from one of its own
nightlies, possibly older than the verified one, so it does not take entries
verified on nightlies of its own version. Servers read the manifest from
`main`, so merging a change to it publishes it, and they ignore the bundled
copy and any fetched copy older than two days.

The [Provider canary](../../.github/workflows/provider-canary.yml) workflow runs
hourly (at 23 minutes past; GitHub may start scheduled runs late), after every
successful Fork Nightly run, and on demand. A run with nothing new to verify
stops after a quick npm and GitHub lookup. For Codex,
Claude Code, and OpenCode it finds npm releases that the latest nightly and the
oldest nightly published in the last seven days may not install yet, installs
each one into an isolated prefix, and runs real turns against that build's
server, checked out from its release tag: a tool turn, a shell command that
must not see the server's own `T3CODE_PORT`, the tool turn's checkpoint, a
resumed follow-up, an interrupt, an approval round trip, a routine write in
Auto that must not ask for approval (on providers that report an Auto reviewer),
a rewind after which the provider must forget the rewound turn but remember the
one before it, a native subagent, and follow-ups after a server restart. It
fails on error items or server warnings any of them leave behind. A failed run is retried once; a pass
on the retry is still recorded and is listed in an open canary issue. Versions that
pass are recorded in one pull request from `automation/provider-canary`, which
also keeps that pull request's earlier additions. Builds whose tag predates the
canary are skipped. Publication dates come from npm; stable builds are not
selected. When the older nightly passes, its approval also covers later builds,
so provider updates do not require the newest styal nightly. If only the latest
nightly passes, older builds keep their previous approved provider version.

A release that fails on a build is not verified on that build again for six
hours. A new nightly or a new provider release is verified on the next run. A
dispatch with `force` verifies it at once.

## Auto-merge

The workflow turns on auto-merge (squash) for the canary pull request, so it
merges once the required checks pass. It does this only when the pull request
changes nothing but the model manifest, and in the manifest only `updatedAt`,
which must move forward, and `autoUpdates` arrays that recording the new
entries on `main` reproduces exactly: entries for the canary's own packages,
in a supported range, with the entries recording prunes. Any other change turns
auto-merge off, and the pull request body says why. Review and merge it by hand
then.

Auto-merge is turned on with the workflow's `GITHUB_TOKEN`, not the app token.
The app may bypass `main`'s rulesets, so auto-merge it turned on would not wait
for the required checks. A merge by `GITHUB_TOKEN` starts no workflows, so
`main` gets no Fork CI run or nightly for it. Servers read the manifest from
`main`, so they need neither.

## Failure reporting

The report job runs from `main`, while verification runs from release tags. Reporting changes take effect on the next run after merge without publishing a nightly. A new problem opens an issue labeled `provider-canary` and `bug`, with the run, failing versions, first error lines, and last passing versions where known. The workflow attempts to assign the repository owner for GitHub notifications; assignment failures warn without losing the issue. Opening it sends a Discord announcement and a repository webhook for issue triage. The old **Provider canary status** issue is no longer used.

While an issue is open, the report comments only when the problem set changes, including a new failing version or a provider recovering while others still fail, and updates the title to the current problem set. It retains problems for providers a dispatch did not check. Held failing versions remain listed on every hourly report without another issue or comment; they are verified again after six hours, on a new build or provider release, or with `force`. When every problem clears, the report updates the body with the recovery time and run URL, comments once, and closes open canary issues as completed. Cancelled runs leave issues unchanged. Issue API errors fail the job; Discord delivery errors warn.

The planner reads six-hour holds only from open `provider-canary` issues. Manually closing one removes its hold state: the next run verifies an eligible version again and opens a replacement if it still fails. Later hourly reports remain quiet while that replacement stays open. Repeated manual closures can produce one replacement each. At migration, the retired issue is already closed and no labeled issue exists, so the first run has no holds and verifies eligible versions immediately, including any version previously held. A passing version is recorded normally; another failure opens the new issue and establishes its hold.

The verifier loads the sanitizer from `main` even when verifying an older release tag. It redacts known API keys (including line-wrapped, JSON-escaped, URL/form-encoded, base64, and base64url forms) and recognizable token patterns before uploading outcomes; known values shorter than eight characters are ignored for exact matching with a warning naming `API_KEY`, while pattern matching still applies; the reporter applies pattern redaction again. Hidden hold records contain only provider, package name, provider version, styal build, and failure timestamp. Separate problem summaries are capped at 200 characters to preserve unevaluated providers and identify changed problems; failure details are not stored in hold records. Hidden state is schema-validated; malformed state is ignored with a warning, and future or expired timestamps cannot establish a hold. Reports allow at most eight problems and eight holds, bound each stored field, and reject bodies of 30,000 bytes or more before sending them to GitHub.

The verifier's own output never reaches the job log, since output cut off mid-key no longer matches the key. The log shows each attempt's exit status; failed scenarios appear in the step summary from the sanitized `result.json`. The output goes to a file on the runner and joins the evidence as `verifier-output.log` only when the verifier exited on its own, its `result.json` passed sanitization and validation, and the output is at most 16 MiB. An attempt that did not finish that way also drops its `server.log`. If `result.json` fails sanitization or validation, the provider run publishes no evidence artifact, skips further verification attempts, and reports “Verification result could not be published safely because it failed sanitization or validation.” A verifier that exits successfully without a valid result is never recorded as passing. If the step is stopped, it records “Verification was stopped before it finished.”, publishes no evidence, stops the verifier with SIGTERM and then SIGKILL after 5 seconds, and deletes the raw output. If the runner kills the step during that cleanup, the raw output stays on the runner, which never uploads it, and an outcome not yet recorded is recorded by the next step as “setup, install or verification did not finish”. Before an evidence upload, every uploaded file is sanitized: JSON and event journals field by field, and `server.log` and `verifier-output.log` as text. A malformed JSON file or journal line withholds the whole evidence artifact; the outcome is still reported.

Redaction of the known API key (`API_KEY`) covers exactly these forms: raw; URL-encoded, in upper or lower case hex; form-encoded; base64 at all three byte alignments, padded or not, so also inside a larger base64 value; base64url; and every character written as a `\uXXXX` escape. Each of those forms is also covered JSON-escaped one, two or three times. The sanitizer removes the whole key in any covered form, and any 12 or more consecutive characters of one, allowing whitespace and escaped line breaks between characters. Not covered:

- fragments of 11 characters or fewer of a covered form, such as what remains when a key is cut off right at its start;
- other encodings, such as hex;
- JSON nesting deeper than three levels;
- any other transformation of the key.

Unknown secrets are caught only by the token patterns (`sk-`, `ghp_`, Bearer and labeled values), and only at their full minimum length. This repository and its workflow artifacts are public.

For a read-only report, download a run's `canary-plan` and `canary-outcome-*` artifacts, then run:

```sh
GITHUB_REPOSITORY=incognitojam/styal GITHUB_TOKEN="$(GH_REPO=incognitojam/styal gh auth token)" node scripts/provider-canary.ts report --dry-run --plan path/to/plan.json --outcomes path/to/outcomes --plan-result success --record-result skipped --run-url https://github.com/incognitojam/styal/actions/runs/RUN_ID
```

The dry run reads open labeled issues and prints the proposed action without changing issues or sending Discord messages.

- **Failed verification:** download the evidence artifact from the linked run.
  If the provider changed its protocol, fix the adapter on `main`; the run that
  follows the nightly with the fix tests the release again.
- **Not in a supported range:** widen the policy's `ranges` by hand once styal
  supports the release.

## Withdrawing a version

To stop servers installing a recorded version, remove its entry from
`autoUpdates`, keep the policy itself, and set `updatedAt` to the current time.
Do not revert the commit that added it: servers ignore a manifest whose
`updatedAt` is older than the one they hold. Servers that already installed the
version keep it.

## Pull requests

The [Provider rewind](../../.github/workflows/provider-rewind.yml) workflow
runs the rewind scenario on a pull request that changes rollback code: a
provider's adapter runs that provider, and shared rollback code runs all three.
It uses the pull request's own server, the provider's newest release recorded
in `autoUpdates`, and the canary's model, with the same secrets. Pull requests
from forks get no secrets, so the job skips with a notice. It is not a required
check; a failure is retried once, a pass on the retry comments on the pull
request with the first attempt's failure, and the evidence artifact holds the
server log and thread projections. `scripts/provider-canary.ts` lists the paths in
`rewind-plan`; the workflow's `paths` filter must cover them.

## Setup

The workflow needs:

- `OPENAI_API_KEY` secret for Codex.
- `ANTHROPIC_API_KEY` secret for Claude Code.
- `OPENROUTER_API_KEY` secret for OpenCode, which runs an OpenRouter model.
- `NIGHTLY_APP_CLIENT_ID` variable and `NIGHTLY_APP_PRIVATE_KEY` secret, with
  contents and pull-request write access, to open the pull request.

## Running it locally

These use model usage and a fresh temporary T3 home:

```sh
node apps/server/scripts/verify-provider-live.ts --provider claudeAgent --model claude-haiku-5-5
node apps/server/scripts/verify-provider-live.ts --provider claudeAgent --model claude-haiku-5-5 --scenario approval
node apps/server/scripts/verify-provider-live.ts --provider codex --model gpt-6-luna --scenario rewind
node scripts/provider-canary.ts plan
node scripts/provider-canary.ts record --provider codex --package @openai/codex \
  --version 0.162.1 --styal 0.1.1-nightly.20261015.730
```
