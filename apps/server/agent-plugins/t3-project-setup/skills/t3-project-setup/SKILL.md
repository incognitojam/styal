---
name: t3-project-setup
description: Configure or improve a repository's T3 Code setup using t3.json, an existing project icon, and useful Actions. Use when the user asks to set up T3 Code or change its project configuration.
---

# T3 Code project setup

Inspect the repository before creating or updating `t3.json` at its root. Preserve valid existing entries and use the repository's actual package manager, scripts, and asset paths.

The supported shape is:

```json
{
  "$schema": "https://t3.codes/schema/t3.json",
  "iconPath": "path/to/project-icon.svg",
  "defaultThreadEnvMode": "worktree",
  "scripts": [
    {
      "name": "Dev",
      "command": "pnpm dev -- --port \"$STYAL_WORKSPACE_PORT\"",
      "icon": "play"
    },
    {
      "name": "Setup worktree",
      "command": "pnpm install",
      "icon": "configure",
      "runOnWorktreeCreate": true
    }
  ]
}
```

- `$schema` is optional but recommended for validation and completion.
- `iconPath` is a repository-relative path to an existing SVG, PNG, ICO, JPEG, GIF, AVIF, or WebP image. Prefer a recognizable square app mark already in the repository. Do not invent a path or add an image unless the user asks for one.
- `defaultThreadEnvMode` is optional and accepts `"worktree"` or `"local"`.
- `scripts` become importable Actions. Each needs a `name` and `command`; `icon` may be `play`, `test`, `lint`, `configure`, `build`, or `debug`; `runOnWorktreeCreate` defaults to false.
- Prefer useful project-specific actions such as development, test, lint, build, and an idempotent dependency/setup command. Do not add redundant wrappers.
- Use `$STYAL_WORKSPACE_PORT` for a development server that needs a stable port. Actions also receive `$STYAL_PROJECT_ROOT` and, in a worktree, `$STYAL_WORKTREE_PATH`. Use the environment's shell syntax when it is not POSIX.
- A checked-in script is a template. T3 Code runs it only after a user imports it as an Action; the imported action is a saved copy and does not track later `t3.json` edits.
- A `runOnWorktreeCreate` action runs only in a fresh worktree. Keep it non-interactive and safe to rerun, and never copy credentials or overwrite files in the original checkout.
- Set `runOnWorktreeCreate` on at most one script. If more than one imported script enables it, T3 Code uses the first one as the automatic setup action.
- T3 Code accepts JSON with comments and trailing commas, but prefer ordinary JSON unless preserving an existing JSONC style.
