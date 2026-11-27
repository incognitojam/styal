# Project setup

Define shared actions in the project’s `t3.json` under `scripts`.
Read the repository's package manager, lockfile, scripts, setup instructions and CI before
suggesting a few frequently used commands. Prefer existing scripts over command chains.

```json
{
  "defaultThreadEnvMode": "worktree",
  "scripts": [
    {
      "name": "Install",
      "command": "pnpm install",
      "icon": "configure",
      "runOnWorktreeCreate": true,
      "async": false
    },
    { "name": "Dev server", "command": "pnpm dev", "icon": "play" },
    { "name": "Test", "command": "pnpm test", "icon": "test" }
  ]
}
```

styal reads actions from origin’s last fetched default branch (then origin/main or origin/master).
Without those refs it reads the project-root file. A person approves each exact command per project
and machine. Unapproved unattended actions are skipped. `t3_project_read` shows approval status.

Scripts require `name` and `command`. Setup scripts use `runOnWorktreeCreate`; `async: false`
holds the agent until setup exits. `runOnSettle` runs a script when its thread settles; threads
without their own worktree skip it. `stopOnSettle` stops the script's terminal and child processes.
Make setup and cleanup safe to run twice. Icons are `play`, `test`, `lint`, `configure`, `build` or `debug`. An invalid value makes the whole
file invalid.

`t3.json` also supports `iconPath`, `defaultThreadEnvMode` (`worktree` or `local`) and
`worktreeSubmodules` (`recursive`, `top-level` or `none`). Project and environment settings can
override file defaults. `worktreeSubmodules` is read from the new worktree's copy.

Before committing project configuration, check the repository's conventions and whether its
existing file is tracked. Do not commit `t3.json` without the user's agreement.
