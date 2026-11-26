# Troubleshooting

Commands that stop or restart the server can end your own session. Ask the user before running
them and prefer read-only checks first. Provider problems appear in Settings → Providers.

Desktop installs provide `<base-dir>/bin/styal` (`styal.cmd` on Windows), normally
`~/.styal/bin/styal`. Settings offers Add to PATH.

`styal service status` reports whether the background service is installed.
`styal doctor --dry-run` reports database size, reclaimable space and available repairs without
changing anything. Repairs stop an installed background service for the same data directory and
start it again afterwards. The user should quit a manually started server or desktop app and run
repairs from a separate terminal.

`styal trace summary --since 30m` lists spans by count and duration for investigating slowness.
For crashes, sign-in failures or broken setups, the user can run `styal triage` in a terminal
outside styal. It starts a separate Claude Code, Codex or Antigravity session when available, otherwise writes
prompt and context files.

Pass `--base-dir` when checking an install with a non-default data directory.
