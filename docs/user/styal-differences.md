# How styal differs from T3 Code

styal builds on T3 Code with its own choices around workspaces, agent sessions, and code review.
This overview highlights additions and refinements compared with
[T3 Code as of September 16, 2026](https://github.com/pingdotgg/t3code/tree/ed123897943e9175d4a0e92a5a8a09d200573336).
The differences evolve as both projects develop.

styal is in active development. The hosted web app at [app.styal.build](https://app.styal.build) is
live, with rough edges and incomplete functionality. Importing T3 Code projects and preferences
works. This overview focuses on desktop and web; the mobile app is a work in progress.

## Mobile

- **Android updates inside the app.** styal offers APK updates in **Settings → About styal**,
  downloads them with progress and cancellation, then opens Android's installer. T3 Code has
  over-the-air updates but no in-app APK installer as of
  [revision 454b94a](https://github.com/pingdotgg/t3code/tree/454b94a13aea918f27bb060d8d054d4cfb791bc2).
  [Install and update the mobile app](./install.md#mobile-app).

## Command line

- **Explicit startup and styal Link naming.** Running `styal` without a subcommand shows command
  guidance; use `styal start` for the browser-opening server or `styal serve` for a headless host.
  styal also exposes its managed remote-access setup as `styal link`, while accepting the upstream
  `connect` spelling as a compatibility alias. [Install styal](./install.md) and
  [Remote access](./remote-access.md).
- **Agent control with `styal drive`.** Scripts and agents can read and change a running
  environment as JSON, send real messages, and serve repeatable synthetic states such as streaming,
  error, and archived threads. T3 Code has this only as an open pull request
  ([#10411](https://github.com/pingdotgg/t3code/pull/10411)) as of
  [September 24, 2026](https://github.com/pingdotgg/t3code/tree/b2b43bef73447c483ceae486890cb79f01c369cb).
  [Drive styal from an agent](./drive.md).

## Workspaces and agent sessions

- **Separate Gemini model and reasoning choices.** Antigravity lists each Gemini generation once,
  with a separate reasoning effort control. Existing threads retain their selected effort.
  T3 Code lists thinking variants as separate models as of
  [revision 5cc99e1](https://github.com/pingdotgg/t3code/tree/5cc99e1c23980d7995a13c47f969b47cb68ed1be).
  [Antigravity](./providers-antigravity.md).

- **Claude Code starts with Opus 5.5.** New Claude Code threads select Opus 5.5 when the installed
  CLI supports it; older installations use an available Claude model. T3 Code defaults to Fable 5.1
  as of [revision f5ef0dd](https://github.com/pingdotgg/t3code/tree/f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc0618).
- **Codex starts with GPT-6.1-Sol at medium effort.** New Codex threads select GPT-6.1-Sol when
  available, then GPT-6-Sol, GPT-6-Astra or an older model offered by the installed CLI. T3 Code
  defaults to GPT-6-Astra as of
  [revision 2cbc24f](https://github.com/pingdotgg/t3code/tree/2cbc24fcae2b5649d7b60b68da72053a37fa82d5).
- **New threads start in a worktree.** Both apps support isolated Git worktrees. After project,
  environment, and `t3.json` settings, styal defaults to a worktree when the project is a Git
  repository with a commit, and the current checkout otherwise. T3 Code defaults to the local
  checkout at this last step as of
  [revision a6ec88f](https://github.com/pingdotgg/t3code/tree/a6ec88f7a716fc421bd22c2484881c44110f9375).
  Once a newly initialized repository has its first commit, the worktree default takes effect.
  [Working with threads](./thread-sidebar.md).
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
- **Review shared actions before importing.** Selecting an action from `t3.json` opens its command
  for review before saving a checkout-local copy. The confirmation states when the action will run
  in new worktrees or replace an existing setup action. [Project actions](./project-scripts.md). Compared with
  [T3 Code revision d7819c1](https://github.com/pingdotgg/t3code/tree/d7819c18813fa03b033cc1c9472c9acc0ffc0618),
  checked September 22, 2026, which imports file actions when selected.
- **Drafts that follow you.** Existing-thread draft text and model settings sync between clients
  connected to the same server. Attachments and other device-specific context stay local; drafts
  containing that context are withheld from other clients to avoid sending an incomplete message.
  [Composer drafts](./composer-drafts.md).

## GitHub and code review

- **Immediate label feedback.** Adding or removing a pull request label updates the view immediately;
  you can keep selecting labels while changes are pending. If the host rejects an edit, that change
  rolls back independently. T3 Code waits for confirmation
  as of [revision 5cc99e1](https://github.com/pingdotgg/t3code/tree/5cc99e1c23980d7995a13c47f969b47cb68ed1be),
  checked October 1, 2026.
- **Forks with an explicit destination.** Cloning a GitHub fork configures its parent remote and lets
  you choose the default repository for pull requests and issues. Adding an existing folder whose
  remotes point at several GitHub repositories asks the same question, and project settings can
  change the choice later. It is the setting `gh repo set-default` stores, so T3 Code and the GitHub
  CLI target the same repository. [Source control integrations](./source-control.md#choose-the-default-repository).
  Compared with [T3 Code revision 611132c](https://github.com/pingdotgg/t3code/tree/611132c171f3a821bd2e32f22261135cef6330ac),
  checked October 7, 2026, which does not add a fork's parent when cloning, offers no way to choose
  the default repository, and links pull requests to a project's `upstream` remote even when the
  default is another repository.
- **A dedicated view of required checks.** T3 Code already displays checks and supports auto-merge.
  styal adds a separate Checks tab that identifies checks required by repository policy and shows
  required checks that have not reported yet. When branch rules require current checks, it explains
  why an out-of-date branch must be updated before auto-merge can finish and offers the permitted
  update methods. [Code review](./source-control.md#review-and-merge).
  Compared with [T3 Code revision a493946](https://github.com/pingdotgg/t3code/tree/a493946bb42ab16e1d18285dac3e9e4603651330),
  checked September 23, 2026.

- **Code review findings in the conversation.** When Claude Code's `/code-review` reports its
  findings, they appear as a list with links to each file and line, and stay visible after the turn
  collapses. Compared with
  [T3 Code revision d15210c](https://github.com/pingdotgg/t3code/tree/d15210cd3da79f9a1a495a6309d912d76362a046),
  checked September 28, 2026, where the report is only visible as a collapsed tool call.

## Staying oriented while agents work

- **Confirm unpinning on mobile.** Mobile asks before removing a thread from the pinned
  section, with a device-local opt-out in **Settings → Thread behavior**. T3 Code mobile
  unpins immediately and has no Undo as of
  [revision a6ec88f](https://github.com/pingdotgg/t3code/tree/a6ec88f7a716fc421bd22c2484881c44110f9375),
  checked October 8, 2026. Web and desktop follow T3 Code's opt-in confirmation and Undo.
  [Pin and reorder threads](./thread-sidebar.md#pin-and-reorder-threads).
- **Choose what thread times mean.** The sidebar defaults to when you last prompted the agent;
  Settings can instead show the latest message, including agent replies. This changes the time
  shown without rearranging threads. Compared with
  [T3 Code revision d2c9281](https://github.com/pingdotgg/t3code/tree/d2c9281b8112dc3b2991642c4bdb985e4b08b9bb),
  which shows the last user message without this choice. [Working with threads](./thread-sidebar.md).
- **Threads grouped by project.** An optional setting lists active threads under a header for
  each project, and dragging a header reorders projects. Compared with
  [T3 Code revision 5cc99e1](https://github.com/pingdotgg/t3code/tree/5cc99e1c23980d7995a13c47f969b47cb68ed1be),
  checked October 1, 2026, which shows active threads as one list; an open pull request
  ([#13815](https://github.com/pingdotgg/t3code/pull/13815)) proposes collapsible, title-only
  groups instead. [Group threads by project](./thread-sidebar.md#group-threads-by-project).
- **Proactive panels by default.** Newly linked reviews open automatically, and completed agent work
  switches to its diff. You can turn this off in Settings. Compared with
  [T3 Code revision f223312](https://github.com/pingdotgg/t3code/tree/f22331240ed1a97fae560e314bffb75fe39db8ca),
  checked September 23, 2026, where proactive panels are opt-in.
- **Tokens per turn.** Each completed turn shows the tokens it used beside its timestamp; hover
  or tap for the input, cached, output, and reasoning breakdown. Compared with
  [T3 Code revision c2fa9fc](https://github.com/pingdotgg/t3code/tree/c2fa9fc911daeac97df4760f95fc57dca42b84c8),
  checked September 30, 2026, which shows token use only on its Usage page and context meter.
  [See what a turn used](./usage.md#see-what-a-turn-used).
- **Optional Discord activity.** The desktop app can share the number of active threads and
  their projects, without sharing names or conversation content. Settled, snoozed, and archived
  threads are excluded. [Discord Rich Presence](./discord-rich-presence.md). Compared with
  [T3 Code revision 9ea9c3d](https://github.com/pingdotgg/t3code/tree/9ea9c3d5d2c444133e3ddff40eecf38737951589),
  checked September 18, 2026, which does not include Rich Presence.
- **A sound choice for each alert.** T3 Code provides fixed completion and attention sounds as of
  [revision 35be904](https://github.com/pingdotgg/t3code/tree/35be904f2fc40aa6d7a42778b6895e8274f3097f).
  styal lets you independently select and preview those sounds or Avanti for completion, input,
  and approval alerts, or silence an event. [Completion sounds](./thread-sidebar.md#completion-sounds).
- **Relevant outage notices.** Sidebar notices surface GitHub, Claude, and OpenAI incidents relevant
  to your projects and providers. Alerts are configurable.
  [GitHub](./source-control.md), [Claude](./providers-claude.md),
  and [Codex](./providers-codex.md).
- **Fewer terminal-close prompts.** T3 Code already asks for confirmation when closing a terminal.
  styal checks whether a foreground process or setup command is still active, so idle terminals close
  immediately while active work retains the confirmation.
- **Typing returns the terminal to the prompt.** When you have scrolled back through terminal output,
  typing or pasting jumps to the bottom, like Ghostty and most desktop terminals. New output and
  scrolling still leave your position alone. Compared with
  [T3 Code revision d15210c](https://github.com/pingdotgg/t3code/tree/d15210cd3da79f9a1a495a6309d912d76362a046),
  checked September 28, 2026.
- **Times in your time zone.** Times an agent writes, such as `14:20 UTC` or `49 minutes ago`,
  show the moment in your own time zone and how far it is from now when you hover them. This helps
  when the agent's machine runs in another zone. Compared with
  [T3 Code revision 5cc99e1](https://github.com/pingdotgg/t3code/tree/5cc99e1c23980d7995a13c47f969b47cb68ed1be),
  checked October 1, 2026, which shows these times as plain text.
  [Reading the chat timeline](./chat-timeline.md).
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
  The **Update server** action checks the connected server the same way before it restarts.
  Compared with [T3 Code revision d4d5d12](https://github.com/pingdotgg/t3code/tree/d4d5d12e8ba086cfbf79ca3adeb4156b46ead665),
  whose desktop lifecycle does not check host activity before quitting, and
  [T3 Code revision fd46510](https://github.com/pingdotgg/t3code/tree/fd465100581055383126aab922a8da2c5d7952fd), whose server update action
  does not check activity.

- **See where a thread continued.** When a restart continues an agent's work, the thread shows
  **Continued after server restart** at the point the agent picked up again. Compared with
  [T3 Code revision d15210c](https://github.com/pingdotgg/t3code/tree/d15210cd3da79f9a1a495a6309d912d76362a046),
  checked September 28, 2026, which continues the thread without a record in the conversation.
  [Updating styal](./updating.md).

[^import-comparison]: Setup compared with [T3 Code revision 1ab2dfb](https://github.com/pingdotgg/t3code/tree/1ab2dfb5a7bd2996f79407b5d02cae6132a7626c), checked September 17, 2026.

[^setup-comparison]: Hosted setup compared with [T3 Code revision dfbb11b](https://github.com/pingdotgg/t3code/tree/dfbb11bdd7c3f1a5575cb55d3e3abb12be025727), checked September 19, 2026.
