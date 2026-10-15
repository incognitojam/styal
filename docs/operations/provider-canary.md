# Provider canary

Automatic provider updates install only a version listed in `autoUpdates` in
the matching compatibility policy of
[`model-manifest.json`](../../apps/server/src/provider/model-manifest.json).
Each entry names the provider version, the npm package that was installed, and
`after`: the newest published styal release when the canary ran. Servers newer
than `after` contain the code the canary tested, so only they take the entry.
Servers read the manifest from `main`, so merging a change to it publishes it,
and they ignore the bundled copy and any fetched copy older than two days.

The [Provider canary](../../.github/workflows/provider-canary.yml) workflow runs
daily and on demand. For Codex, Claude Code, and OpenCode it finds npm releases
newer than the recorded ones, installs each one into an isolated prefix, and
runs real turns against `main`'s server: a tool turn, its checkpoint, a resumed
follow-up, an interrupt, an approval round trip, a rewind, a native subagent,
and follow-ups after a server restart. It fails on error items or server
warnings any of them leave behind. A failed run is retried once; a pass on the
retry is still recorded and is listed in the status issue. Versions that pass
are recorded in one pull request from `automation/provider-canary`, which also
keeps entries from an earlier unmerged run.

## Status issue

The workflow keeps one issue titled **Provider canary status**, assigned to the
repository owner. It lists releases that failed verification, releases outside
every supported range, providers skipped for missing secrets, and failed jobs.
It comments when a new problem appears and closes when every check passes; a
problem that persists across runs is not reported again.

- **Failed verification:** download the evidence artifact from the linked run.
  If the provider changed its protocol, fix the adapter on `main`; the next run
  tests the release again.
- **Not in a supported range:** widen the policy's `ranges` by hand once styal
  supports the release.

## Withdrawing a version

To stop servers installing a recorded version, remove its entry from
`autoUpdates`, keep the policy itself, and set `updatedAt` to the current time.
Do not revert the commit that added it: servers ignore a manifest whose
`updatedAt` is older than the one they hold. Servers that already installed the
version keep it.

## Setup

The workflow needs:

- `OPENAI_API_KEY` secret for Codex.
- `ANTHROPIC_API_KEY` secret for Claude Code and OpenCode.
- `NIGHTLY_APP_CLIENT_ID` variable and `NIGHTLY_APP_PRIVATE_KEY` secret, with
  contents and pull-request write access, to open the pull request.

## Running it locally

These use model usage and a fresh temporary T3 home:

```sh
node apps/server/scripts/verify-provider-live.ts --provider claudeAgent --model claude-haiku-5-5
node apps/server/scripts/verify-provider-live.ts --provider claudeAgent --model claude-haiku-5-5 --scenario approval
node scripts/provider-canary.ts plan
node scripts/provider-canary.ts record --after 0.1.1-nightly.20261015.730 \
  --provider codex --package @openai/codex --version 0.162.1
```
