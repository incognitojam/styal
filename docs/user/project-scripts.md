# Run project scripts

Project scripts, shown as **Actions** in T3 Code, are saved or checked-in shell commands for common
project tasks such as starting a development server, running tests, or installing dependencies in
a new worktree. They run on the environment that owns the project and open their output in a T3
Code terminal.

## Add an action

On web or desktop, open **Settings** → **Projects**, select a checkout, find **Actions**, and select
**Add action**. You can also add or edit actions from the actions menu in a thread's top bar.

Each action has:

- A name and icon.
- A shell command.
- An optional keyboard shortcut.
- An option to run automatically after T3 Code creates a worktree for a new thread.

Actions are saved for one checkout, not for every checkout in its project group. Saved actions are
available to connected clients, including mobile. On mobile, open a thread's terminal menu to run
one.

T3 Code runs a regular action in the active thread's worktree, or in the project root for a local
thread. If the current terminal is busy, the action opens in another terminal. An automatic setup
action runs after the new worktree is ready, and its progress and result appear in the chat
timeline. Only one saved action per checkout can be the automatic setup action.

The automatic setup action runs only in a worktree. T3 Code refuses to run it from a local thread,
where its working directory would be the project root: a setup command that copies or links files
from `STYAL_PROJECT_ROOT` into its working directory would overwrite the checkout's own copies of
those files.

## Declare shared actions in `styal.json`

Add `styal.json` at the repository root to expose actions automatically to everyone who opens the
repository in T3 Code:

```json
{
  "$schema": "https://styal.build/schema/styal.json",
  "scripts": [
    {
      "id": "install",
      "name": "Install dependencies",
      "command": "pnpm install",
      "icon": "configure",
      "runOnWorktreeCreate": true
    },
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
JSON Schema. T3 Code also accepts comments and trailing commas in this file.

Each script supports these fields:

- `id` (optional): a stable lowercase identifier for keybindings such as `script.dev.run`. When
  omitted, T3 Code derives one from `name`.
- `name` (required): the label shown in T3 Code.
- `command` (required): the shell command to run.
- `icon` (optional): `play`, `test`, `lint`, `configure`, `build`, `debug`, `desktop`, `database`,
  or `deploy`. The default is `play`.
- `runOnWorktreeCreate` (optional): marks the script as the checkout's setup action. Checked-in
  setup actions do not run automatically. The default is `false`.

Scripts in `styal.json` appear directly in the active checkout's thread toolbar and in **Settings**
→ **Projects** → **Actions**. They are not copied into project settings. Opening the actions menu,
returning to a mobile thread, or selecting **Refresh file** in project settings reloads the file, so
changes follow the checkout that contains them. A thread in a worktree reads that worktree's copy
instead of waiting for the main checkout to update.

Saved actions remain available for machine- or checkout-specific commands. When a file action and a
saved action have the same ID, the file action wins in the toolbar; delete the old saved copy after
migrating it to `styal.json`. Actions with different IDs remain available even when their names or
commands match, so existing ID-based keyboard shortcuts continue to work.

Running a checked-in action manually is an explicit user action. Automatic setup remains limited to
saved setup actions; merely opening a repository does not grant a checked-in command permission to
execute.

If `styal.json` is invalid, T3 Code ignores the entire file. **Settings** → **Projects** shows a
warning so you can correct its syntax or field values.

## Legacy `t3.json` files

When the current checkout has no `styal.json`, T3 Code continues to read its legacy `t3.json`.
Legacy scripts retain their existing import behavior: choose one from the thread's actions menu or
from **Settings** → **Projects** → **Actions** to create a saved copy for that checkout. They do not
become live actions automatically.

`styal.json` takes ownership as soon as it exists in that checkout. T3 Code does not fall back to
`t3.json` when `styal.json` is invalid, because doing so would conceal the configuration error. Git
worktrees resolve these files independently, so a branch can adopt `styal.json` without changing
another checkout until that repository change is committed and merged.

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

The assigned range is stable across restarts and does not overlap with another T3 Code workspace
in the same environment. It does not reserve the sockets from unrelated programs on the host. See
[Project settings](./project-settings.md#stable-workspace-ports) for allocation details and
[Keyboard shortcuts](./keybindings.md#commands) for binding saved actions to keys.
