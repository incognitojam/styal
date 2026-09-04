# Give agents project instructions

Use **Additional instructions** in a project's settings to provide guidance whenever T3 Code
starts an agent session for that project. The setting is shared by every checkout in the project
group and works with Codex, Claude, Cursor, Grok, and OpenCode.

Clear the field or select its reset button to stop including the instructions in future sessions.

# Customize a project icon

T3 Code selects a project icon automatically. It checks `styal.json`, falls back to `t3.json` when
the new file is absent, then checks common favicon and app icon paths and icon links in project HTML
files.

To choose a different icon:

1. Open the projects filter and select the settings icon for the project.
2. Under **Appearance**, select **Choose a project file**.
3. Search for an image file and select it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

# Stable workspace ports

T3 Code automatically assigns every workspace a persistent range of ten development ports. There
is no setting to enable. The first port is always available as `STYAL_WORKSPACE_PORT` in that
workspace's locally launched agent processes, terminals, and project scripts; the remaining ports
are the next nine numbers.

A worktree keeps the same range when its agent or development server restarts. Threads that reuse
the same worktree also reuse its range. Local threads share the range assigned to the project's main
checkout.

For example, a checked-in `styal.json` script can start its development server on the assigned port:

```json
{
  "$schema": "https://styal.build/schema/styal.json",
  "scripts": [
    {
      "id": "dev",
      "name": "Dev server",
      "command": "npm run dev -- --port \"$STYAL_WORKSPACE_PORT\""
    }
  ]
}
```

Use `$((STYAL_WORKSPACE_PORT + 1))` through `$((STYAL_WORKSPACE_PORT + 9))` in shell commands when
a workspace needs multiple services. The allocation prevents T3 Code workspaces in the same
environment from receiving overlapping ranges, but it does not reserve listening sockets from
unrelated programs on the host.

See [Project scripts](./project-scripts.md) for the full `styal.json` script format and the other
project environment variables available to actions and terminals.
