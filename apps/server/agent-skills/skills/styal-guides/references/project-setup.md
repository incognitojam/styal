# Project setup

This build uses `t3.json` at the project root, with `scripts`, not `styal.json` actions.
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

Adding a script to `t3.json` runs nothing until the user imports it in Settings → Projects →
Actions → Import scripts → Import from t3.json. The file is read from the registered checkout;
an edit in a thread worktree affects these scripts and defaults only after it reaches that checkout.

Scripts require `name` and `command`. Setup scripts use `runOnWorktreeCreate`; `async: false`
holds the agent until setup exits. `runOnSettle` runs a script when its thread settles; threads
without their own worktree skip it. `stopOnSettle` stops the script's terminal and child processes.
Make setup and cleanup safe to run twice. Icons are `play`, `test`, `lint`, `configure`, `build` or `debug`. An invalid value makes the whole
file invalid.

`t3.json` also supports `iconPath`, `defaultThreadEnvMode` (`worktree` or `local`) and
`worktreeSubmodules` (`recursive`, `top-level` or `none`). Project and environment settings can
override file defaults. `worktreeSubmodules` is read from the new worktree's copy.

Before committing project configuration, check the repository's conventions and whether its
existing file is tracked. Do not commit `t3.json` without the user's agreement. Users can save scripts in
styal instead of committing a file.
