# Project settings

Open **Settings → Projects** and select a project to change its preferences.

## Project icons

Choose an icon, emoji, or image from the project to make it easier to recognize. The choice applies
to every checkout in the project group and appears on connected clients. Choose **Automatic** to
let T3 Code detect an icon again.

## Give agents project instructions

Use **Additional instructions** to provide guidance whenever T3 Code starts an agent session for
the project. The instructions apply to every checkout in the project group and work with Codex,
Claude, Cursor, Grok, and OpenCode. Clear the field or reset it to stop including them in future
sessions.

## Keep the default branch current

Enable **Automatically pull** to keep the default-branch checkout up to date with its configured
upstream.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.

## Stable workspace ports

Every workspace receives a persistent range of ten development ports; there is no setting to
enable. Agents, terminals, and project scripts launched locally for the workspace receive the first
port as `STYAL_WORKSPACE_PORT`, and the range continues with the next nine numbers. A worktree
keeps its range across restarts, and local threads share the range of the project's main checkout.

For example, a project script can run `npm run dev -- --port "$STYAL_WORKSPACE_PORT"` and give a
second service `$((STYAL_WORKSPACE_PORT + 1))`. Workspaces in the same environment never receive
overlapping ranges, but unrelated programs on the machine can still listen on those ports.

See [Project scripts](./project-scripts.md) for the script format and other project environment
variables.
