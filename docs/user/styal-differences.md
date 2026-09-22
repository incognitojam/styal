# How styal differs from T3 Code

styal builds on T3 Code with its own choices around workspaces, agent sessions, and code review.
This overview highlights additions and refinements compared with
[T3 Code as of September 16, 2026](https://github.com/pingdotgg/t3code/tree/ed123897943e9175d4a0e92a5a8a09d200573336).
The differences evolve as both projects develop.

styal is in active development. The hosted web app at [app.styal.build](https://app.styal.build) is
live, with rough edges and incomplete functionality. Importing T3 Code projects and preferences
works. This overview focuses on desktop and web; the mobile app is a work in progress.

## Command line

- **Explicit startup and styal Link naming.** Running `styal` without a subcommand shows command
  guidance; use `styal start` for the browser-opening server or `styal serve` for a headless host.
  styal also exposes its managed remote-access setup as `styal link`, while accepting the upstream
  `connect` spelling as a compatibility alias. [Install styal](./install.md) and
  [Remote access](./remote-access.md).

## Workspaces and agent sessions

- **Worktree defaults and workspace grouping.** Both apps support isolated Git worktrees. styal
  defaults new threads to a worktree, while T3 Code defaults to the local checkout; either default can
  be changed. styal also nests threads sharing a workspace in the web and desktop sidebar, mobile
  Home list, and tablet sidebar, with the oldest active thread first. Workspace grouping compared with
  [T3 Code on September 22, 2026](https://github.com/pingdotgg/t3code/tree/d7819c18813fa03b033cc1c9472c9acc0ffc0618).
  [Organizing threads](./thread-sidebar.md).
- **Stable development ports.** Each workspace gets a persistent range of ten ports. Agents,
  terminals, and project scripts receive the same assignment across restarts, so parallel workspaces
  can run development servers without choosing the same ports.
  [Workspace ports](./project-settings.md#stable-workspace-ports).
- **Development links open on their environment.** Loopback links in chat and terminal activity open
  in the integrated browser on the environment that runs the server, even if other links are set to
  open in your default browser. Compared with
  [T3 Code revision 18062da](https://github.com/pingdotgg/t3code/tree/18062da9425909a0a92bce0b692c9de6fbba56ee),
  which applies the browser setting to these links too.
- **Project instructions across providers.** Set additional instructions once for a project and use
  them across its checkouts and agent sessions with Codex, Claude, Cursor, Grok, and OpenCode.
  [Project instructions](./project-settings.md#give-agents-project-instructions).
- **Drafts that follow you.** Existing-thread draft text and model settings sync between clients
  connected to the same server. Attachments and other device-specific context stay local; drafts
  containing that context are withheld from other clients to avoid sending an incomplete message.
  [Composer drafts](./composer-drafts.md).

## GitHub and code review

- **Forks with an explicit destination.** Cloning a GitHub fork configures its parent remote and lets
  you choose the default repository for pull requests and issues. The choice stays consistent with
  the GitHub CLI, while branches that track a remote keep their own repository association.
  [Source control integrations](./source-control.md).
- **A dedicated view of required checks.** T3 Code already displays checks and supports auto-merge.
  styal adds a separate Checks tab that identifies checks required by repository policy and shows
  required checks that have not reported yet. Its merge action accounts for GitHub's policy blockers,
  including pending reviews or an out-of-date branch.
  [Code review](./source-control.md#manage-code-reviews-without-context-switching).

## Staying oriented while agents work

- **Optional Discord activity.** The desktop app can share the number of active threads and
  their projects, without sharing names or conversation content. Settled, snoozed, and archived
  threads are excluded. [Discord Rich Presence](./discord-rich-presence.md). Compared with
  [T3 Code revision 9ea9c3d](https://github.com/pingdotgg/t3code/tree/9ea9c3d5d2c444133e3ddff40eecf38737951589),
  checked September 18, 2026, which does not include Rich Presence.
- **A choice of completion sounds.** T3 Code already has sounds for completion and input requests.
  styal lets you select and preview Resolve or Avanti as the sound for those events, or turn it off.
  [Completion sounds](./thread-sidebar.md#completion-sounds).
- **Relevant outage notices.** Sidebar notices surface GitHub, Claude, and OpenAI incidents relevant
  to your projects and providers. Alerts are configurable.
  [GitHub](./source-control.md), [Claude](./providers-claude.md),
  and [Codex](./providers-codex.md).
- **Fewer terminal-close prompts.** T3 Code already asks for confirmation when closing a terminal.
  styal checks whether a foreground process or setup command is still active, so idle terminals close
  immediately while active work retains the confirmation.
- **Complete conversation export.** Copy a thread's user and assistant messages as Markdown,
  including history that is not currently loaded in the view.
  [Transcripts](./thread-sidebar.md#copying-a-transcript).

## Bringing your work from T3 Code

- **Setup stays focused on new computers.** On the hosted app, first-time connection setup waits
  for live workspace data and skips Agents and Import for computers that already contain projects
  or threads. An explicit visit to `/welcome` still reopens the complete setup flow.[^setup-comparison]
- **Import without replacing your existing setup.** Bring projects, threads, attachments, and
  supported preferences into styal while leaving the T3 Code installation intact. Existing styal
  project settings take precedence, and interrupted imports can resume without duplicating completed
  threads. Migration is available during setup and later in Settings; setup reviews differing
  preferences in a separate step.[^import-comparison] Credentials and active sessions remain separate.
  [Import T3 Code data](./importing-t3-code-data.md).

## Desktop updates

- **Updates ready for your next launch.** styal downloads updates in the background and installs
  them when you quit. The sidebar shows an icon only when you can restart to update immediately;
  checks, download progress, and retries are available in Settings.
  [Updating styal](./updating.md). Compared with
  [T3 Code revision 1ab2dfb](https://github.com/pingdotgg/t3code/tree/1ab2dfb5a7bd2996f79407b5d02cae6132a7626c),
  which disables automatic downloads and installation on quit.

- **Confirm only when quitting may interrupt work.** Desktop quits and restarts check agents and
  terminal work across the environments hosted by the app, including work started from other devices.
  Idle hosts proceed without a dialog; active work or an unavailable check requires an in-app confirmation.
  Compared with [T3 Code revision d4d5d12](https://github.com/pingdotgg/t3code/tree/d4d5d12e8ba086cfbf79ca3adeb4156b46ead665),
  whose desktop lifecycle does not check host activity before quitting.

[^import-comparison]: Setup compared with [T3 Code revision 1ab2dfb](https://github.com/pingdotgg/t3code/tree/1ab2dfb5a7bd2996f79407b5d02cae6132a7626c), checked September 17, 2026.

[^setup-comparison]: Hosted setup compared with [T3 Code revision dfbb11b](https://github.com/pingdotgg/t3code/tree/dfbb11bdd7c3f1a5575cb55d3e3abb12be025727), checked September 19, 2026.
