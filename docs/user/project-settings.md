# Customize a project icon

T3 Code selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

# Use stable workspace ports

T3 Code assigns every workspace a persistent range of ten development ports. The first port is
available as `T3CODE_WORKSPACE_PORT` in that workspace's locally launched agent processes,
terminals, and project scripts; the remaining ports are the next nine numbers.

A worktree keeps the same range when its agent or development server restarts. Threads that reuse
the same worktree also reuse its range. Local threads share the range assigned to the project's main
checkout.

For example, a checked-in `t3.json` script can start its development server on the assigned port:

```json
{
  "$schema": "https://t3.codes/schema/t3.json",
  "scripts": [
    {
      "name": "Dev server",
      "command": "npm run dev -- --port \"$T3CODE_WORKSPACE_PORT\""
    }
  ]
}
```

Use `$((T3CODE_WORKSPACE_PORT + 1))` through `$((T3CODE_WORKSPACE_PORT + 9))` in shell commands when
a workspace needs multiple services. The allocation prevents T3 Code workspaces in the same
environment from receiving overlapping ranges, but it does not reserve listening sockets from
unrelated programs on the host.
