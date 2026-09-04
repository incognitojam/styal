# Run project scripts

Project scripts, shown as **Actions** in T3 Code, are shell commands for common project tasks such
as starting a development server, running tests, or installing dependencies in a new worktree.
They run on the environment that owns the project and open their output in a T3 Code terminal.

## Add an action

On web or desktop, open the projects filter, select the settings icon for a project, find
**Actions**, and select **Add action**. You can also add or edit actions from the actions menu in a
thread's top bar.

When the checkout has no `styal.json`, new actions are stored locally in Styal and are available to
the project's local and worktree threads. Select **Create styal.json** to copy those actions into
the current checkout when you want to share them through the repository. When `styal.json` already
exists, additions and edits update that exact checkout's file.

Each action has:

- A name and icon.
- A shell command.
- An optional keyboard shortcut.
- For locally stored actions, an option to run it after Styal creates a worktree.

Both local and file actions are available to connected clients, including mobile. On mobile, open
a thread's terminal menu to run one.

T3 Code runs an action in the active thread's worktree, or in the project root for a local thread.
If the current terminal is busy, the action opens in another terminal. A local setup action runs
after Styal creates a worktree because configuring it in Styal establishes consent. Commands read
from `styal.json` never run automatically.

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
      "icon": "configure"
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

Scripts in `styal.json` appear directly in the active checkout's thread toolbar and under
**Actions** in that project's settings. They are not copied into local project settings. Opening
the actions menu, returning to a mobile thread, or selecting **Refresh file** in project settings
reloads the file, so changes follow the checkout that contains them. A thread in a worktree reads
that worktree's copy instead of waiting for the main checkout to update.

Running an action manually is an explicit user action. Merely opening a repository does not grant a
checked-in command permission to execute.

If `styal.json` is invalid, T3 Code ignores the entire file. The project's settings show a warning
so you can correct its syntax or field values. T3 Code does not fall back to local actions while an
invalid file is present because that would conceal the configuration error.

## Legacy `t3.json` files

When the current checkout has no `styal.json`, T3 Code continues to read supported project defaults
from its legacy `t3.json`. Legacy actions are not runnable until you select **Create styal.json** in
the thread actions menu or the project's **Actions** settings. This creates `styal.json` in that
exact checkout, copies supported `t3.json` settings and actions, assigns stable action IDs, and
includes the checkout's local actions. It leaves both legacy sources untouched. A migrated setup
action becomes a regular manual action because checked-in commands are not trusted automatically.

`styal.json` becomes the sole action source as soon as it exists in that checkout. Local actions
remain stored in Styal and can be copied into the file later, but they are not merged into the
runnable list. Git worktrees resolve the file independently, so a branch can adopt `styal.json`
without changing another checkout until that repository change is committed and merged.

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
[Keyboard shortcuts](./keybindings.md#commands) for binding actions to keys.
