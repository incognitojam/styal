# Provider canary

Automatic provider updates install only up to the `autoUpdateVersion` in each
provider's compatibility policy in
[`model-manifest.json`](../../apps/server/src/provider/model-manifest.json).
Servers read that file from `main`, so merging a change to it publishes it.
The policy that applies is the one whose `t3CodeRange` matches the server's
styal version, so older releases keep the version tested for them.

The [Provider canary](../../.github/workflows/provider-canary.yml) workflow runs
daily and on demand. For Codex, Claude Code, and OpenCode it finds npm releases
newer than the recorded version, installs each one into an isolated prefix, and
runs real turns against `main`'s server: a tool turn, its checkpoint, a resumed
follow-up, and an interrupt. Versions that pass are recorded in one pull request
from `automation/provider-canary`. A release outside every supported range is
reported as blocked; widen the ranges by hand if it should be accepted.

The workflow needs:

- `OPENAI_API_KEY` secret for Codex.
- `ANTHROPIC_API_KEY` secret for Claude Code and OpenCode.
- `NIGHTLY_APP_CLIENT_ID` variable and `NIGHTLY_APP_PRIVATE_KEY` secret, with
  contents and pull-request write access, to open the pull request.

A provider whose secret is missing is skipped with a notice.

Run the same checks locally with your own provider login. They use model usage
and a fresh temporary T3 home:

```sh
node apps/server/scripts/verify-provider-live.ts --provider claudeAgent --model claude-haiku-5-5
node scripts/provider-canary.ts plan
node scripts/provider-canary.ts record --provider codex --version 0.162.1
```
