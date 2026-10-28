# Provider canary

styal managed updates install only a version listed in `autoUpdates` in
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
Claude Code, and OpenCode it finds npm releases that the current stable and
nightly styal builds may not install yet, installs
each one into an isolated prefix, and runs real turns against that build's
server, checked out from its release tag: a tool turn, its checkpoint, a
resumed follow-up, an interrupt, an approval round trip, a routine write in
Auto that must not ask for approval (on providers that report an Auto reviewer),
a rewind after which the provider must forget the rewound turn but remember the
one before it, a native subagent, and follow-ups after a server restart. It
fails on error items or server warnings any of them leave behind. A failed run is retried once; a pass
on the retry is still recorded and is listed in the status issue. Versions that
pass are recorded in one pull request from `automation/provider-canary`, which
also keeps that pull request's earlier additions. Builds whose tag predates the
canary are skipped.

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

## Status issue

The workflow keeps one issue titled **Provider canary status**, assigned to the
repository owner. It lists, per provider, releases that failed verification,
releases outside every supported range, and verifications skipped for missing
secrets, plus failed jobs. It comments when a new problem appears and closes
when every check passes. A problem that persists, even across new releases of
the same provider, is not reported again, and it clears only when a later run
checks that provider again.

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
