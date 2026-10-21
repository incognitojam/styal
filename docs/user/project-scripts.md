# Run project scripts

Project scripts, shown as **Actions** in T3 Code, are saved shell commands for common project tasks
such as starting a development server, running tests, or installing dependencies in a new
worktree. They run on the environment that owns the project and open their output in a T3 Code
terminal.

## Add an action

On web or desktop, open **Settings** → **Projects**, select a checkout, find **Actions**, and select
**Add action**. You can also add or edit actions from the actions menu in a thread's top bar.

Each action has:

- A name and icon.
- A shell command.
- An optional keyboard shortcut.
- An option to run automatically after T3 Code creates a worktree for a new thread.
- An option to run in a thread's worktree each time the thread settles, for example to delete
  build output. See [Settle finished work](./thread-sidebar.md#settle-finished-work).

Actions are saved for one checkout, not for every checkout in its project group. Saved actions are
available to connected clients, including mobile. On mobile, open a thread's terminal menu to run
one.

T3 Code runs a regular action in the active thread's worktree, or in the project root for a local
thread. If the current terminal is busy, the action opens in another terminal. An automatic setup
action runs after the new worktree is ready, and its progress and result appear in the chat
timeline. Only one saved action per checkout can be the automatic setup action.

The automatic setup action runs only in a worktree. T3 Code refuses to run it from a local thread,
where its working directory would be the project root: a setup command that copies or links files
from `T3CODE_PROJECT_ROOT` into its working directory would overwrite the checkout's own copies of
those files.

## Share actions with `styal.json`

Add `styal.json` at the repository root to offer actions to everyone who opens the repository in
styal:

```json
{
  "$schema": "https://styal.build/schema/styal.json",
  "actions": [
    {
      "id": "dev",
      "name": "Dev server",
      "command": "pnpm dev -- --port \"$STYAL_WORKSPACE_PORT\"",
      "icon": "play"
    },
    {
      "id": "test",
      "name": "Test",
      "command": "pnpm test",
      "icon": "test"
    }
  ]
}
```

The `$schema` entry is optional, but enables validation and suggestions in editors that support
JSON Schema. styal also accepts comments and trailing commas in this file.

Each action supports these fields:

- `id` (optional): a stable identifier made of lowercase letters, digits and dashes, used by
  keyboard shortcuts and local edits. It defaults to one derived from the name. Give actions an
  `id` so renaming one does not drop its shortcut.
- `name` (required): the label shown in styal.
- `command` (required): the shell command to run.
- `icon` (optional): `play`, `test`, `lint`, `configure`, `build`, `debug`, `desktop`, `database`,
  or `deploy`. The default is `play`.
- `runOnWorktreeCreate`, `async`, and `runOnSettle` (optional): mark the action to run when a
  worktree is created or when a thread settles. These are not applied yet: an action from
  `styal.json` only runs when you choose it.

styal reads `styal.json` from the project's own checkout, not from each thread's worktree, so every
thread of the project offers the same actions, and a change to the file shows up without importing
anything. Actions from the file appear in the thread actions menu and in **Settings** → **Projects**
→ **Actions** next to the ones saved in styal, marked with `styal.json`. Review a checked-in
command before running it: it has the same access to the environment and files as a command
entered in a styal terminal.

To change an action from the file for yourself, edit it in styal. styal saves your version under
the same `id`, uses it instead of the file's, and marks it as edited. Choose **Use styal.json
version** in its editor to remove your version again. An action that only exists in `styal.json`
cannot be deleted in styal; remove it from the file instead.

styal keeps reading valid settings and actions when another value fails validation. It ignores an
invalid or unrecognized field, and drops only an action with an invalid or missing `name` or
`command`, or one that repeats an earlier action's `id`. Malformed JSON and files whose root is not
an object cannot be recovered and are ignored entirely. **Settings** → **Projects** shows a warning
when any part of the file is ignored.

### Projects with a `t3.json`

A repository that only has a `t3.json` from T3 Code keeps its settings, and its `scripts` can be
imported: select one from the thread actions menu or from **Settings** → **Projects** →
**Actions** to open the **Add Action** form with the file's values filled in, then review and save
it. Imported actions are saved copies, so later changes to `t3.json` do not change them. Once the
repository has a `styal.json`, styal ignores `t3.json` entirely.

## Project environment variables

T3 Code adds project context to commands it launches. These variables are intended for project
commands and can safely be referenced by actions:

| Variable               | Available in                                                     | Value                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `STYAL_PROJECT_ROOT`   | Actions, plus web and desktop terminals                          | Absolute path to the checkout registered as the project. In a worktree thread, this remains the original checkout path. |
| `STYAL_WORKTREE_PATH`  | Actions, plus web and desktop terminals for a worktree thread    | Absolute path to the thread's worktree. It is unset for local threads.                                                  |
| `STYAL_WORKSPACE_PORT` | Actions, T3 Code terminals, and locally launched agent processes | First port in the workspace's stable range of ten ports.                                                                |

For compatibility with existing project scripts, T3 Code also exposes `T3CODE_PROJECT_ROOT`,
`T3CODE_WORKTREE_PATH`, and `T3CODE_WORKSPACE_PORT` with the same values. New scripts should use
the `STYAL_*` names.

The action's current working directory is normally `STYAL_WORKTREE_PATH` when that variable is
set, otherwise `STYAL_PROJECT_ROOT`. This makes it possible to read shared files from the original
checkout while still modifying and running code in the thread's isolated worktree.

Use the syntax for the environment's shell: `$STYAL_PROJECT_ROOT` in a POSIX shell,
`$env:STYAL_PROJECT_ROOT` in PowerShell, or `%STYAL_PROJECT_ROOT%` in Command Prompt. Shared
actions should use syntax supported by every environment where the project will run.

For example, a POSIX shell action can inspect the paths and use two ports from the assigned range:

```sh
printf 'project=%s\nworktree=%s\n' "$STYAL_PROJECT_ROOT" "${STYAL_WORKTREE_PATH:-local}"
pnpm dev -- --port "$STYAL_WORKSPACE_PORT" &
pnpm run api -- --port "$((STYAL_WORKSPACE_PORT + 1))"
```

Settling a thread leaves running dev servers open. To stop them when the thread settles, use an
action that runs on settle and stops whatever listens on the ports, for example on macOS or Linux:

```sh
for port in "$STYAL_WORKSPACE_PORT" "$((STYAL_WORKSPACE_PORT + 1))"; do
  if pids=$(lsof -ti "tcp:$port" -sTCP:LISTEN); then kill $pids; fi
done
```

The assigned range is stable across restarts and does not overlap with another T3 Code workspace
in the same environment. It does not reserve the sockets from unrelated programs on the host. See
[Project settings](./project-settings.md#stable-workspace-ports) for allocation details and
[Keyboard shortcuts](./keybindings.md#rule-shape) for binding saved actions to keys.
