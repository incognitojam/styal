# Run project scripts

Project scripts, shown as **Actions** in T3 Code, are saved shell commands for common project tasks
such as starting a development server, running tests, or installing dependencies in a new
worktree. They run on the environment that owns the project and open their output in a T3 Code
terminal.

Ask your agent to use the `t3-project-setup` skill for the current repository. The skill supplies
the supported `t3.json` fields and guidance for choosing useful actions and an existing project
icon.

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
from `T3CODE_PROJECT_ROOT` into its working directory would overwrite the checkout's own copies of
those files.

## Share actions with `t3.json`

Add `t3.json` at the repository root to offer actions to everyone who opens the repository in T3
Code:

```json
{
  "$schema": "https://t3.codes/schema/t3.json",
  "scripts": [
    {
      "name": "Install dependencies",
      "command": "pnpm install",
      "icon": "configure",
      "runOnWorktreeCreate": true
    },
    {
      "name": "Dev server",
      "command": "pnpm dev -- --port \"$T3CODE_WORKSPACE_PORT\"",
      "icon": "play"
    },
    {
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

- `name` (required): the label shown in T3 Code.
- `command` (required): the shell command to run.
- `icon` (optional): `play`, `test`, `lint`, `configure`, `build`, `debug`, `desktop`, `database`,
  or `deploy`. The default is `play`.
- `runOnWorktreeCreate` (optional): whether importing this script should make it the automatic
  setup action. The default is `false`.

Scripts in `t3.json` are templates and never run directly from the checked-in file. Import one
from the thread actions menu or from **Settings** → **Projects** → **Actions**. Importing creates a
saved copy for that checkout, so later changes to `t3.json` do not silently change or run an
already-imported action. Edit the saved action, or delete it and import the revised definition,
when you want to adopt a change.

Review a checked-in command before importing it. Once saved, an action has the same access to the
environment and files as a command entered in a T3 Code terminal.

If `t3.json` is invalid, T3 Code ignores the entire file. **Settings** → **Projects** shows a
warning so you can correct its syntax or field values.

## Project environment variables

T3 Code adds project context to commands it launches. These variables are intended for project
commands and can safely be referenced by actions:

| Variable                | Available in                                                     | Value                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `T3CODE_PROJECT_ROOT`   | Actions, plus web and desktop terminals                          | Absolute path to the checkout registered as the project. In a worktree thread, this remains the original checkout path. |
| `T3CODE_WORKTREE_PATH`  | Actions, plus web and desktop terminals for a worktree thread    | Absolute path to the thread's worktree. It is unset for local threads.                                                  |
| `T3CODE_WORKSPACE_PORT` | Actions, T3 Code terminals, and locally launched agent processes | First port in the workspace's stable range of ten ports.                                                                |

The action's current working directory is normally `T3CODE_WORKTREE_PATH` when that variable is
set, otherwise `T3CODE_PROJECT_ROOT`. This makes it possible to read shared files from the original
checkout while still modifying and running code in the thread's isolated worktree.

Use the syntax for the environment's shell: `$T3CODE_PROJECT_ROOT` in a POSIX shell,
`$env:T3CODE_PROJECT_ROOT` in PowerShell, or `%T3CODE_PROJECT_ROOT%` in Command Prompt. Shared
actions should use syntax supported by every environment where the project will run.

For example, a POSIX shell action can inspect the paths and use two ports from the assigned range:

```sh
printf 'project=%s\nworktree=%s\n' "$T3CODE_PROJECT_ROOT" "${T3CODE_WORKTREE_PATH:-local}"
pnpm dev -- --port "$T3CODE_WORKSPACE_PORT" &
pnpm run api -- --port "$((T3CODE_WORKSPACE_PORT + 1))"
```

The assigned range is stable across restarts and does not overlap with another T3 Code workspace
in the same environment. It does not reserve the sockets from unrelated programs on the host. See
[Project settings](./project-settings.md#stable-workspace-ports) for allocation details and
[Keyboard shortcuts](./keybindings.md#commands) for binding saved actions to keys.
