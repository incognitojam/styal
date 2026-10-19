# How styal differs from T3 Code

styal builds on T3 Code with its own choices around workspaces, agent sessions, and code review.
This overview highlights additions and refinements compared with
[T3 Code as of September 16, 2026](https://github.com/pingdotgg/t3code/tree/ed123897943e9175d4a0e92a5a8a09d200573336).
The differences evolve as both projects develop.

styal is in active development. The hosted web app at [app.styal.build](https://app.styal.build) is
live, with rough edges and incomplete functionality. Importing T3 Code projects and preferences
works. This overview focuses on desktop and web; the mobile app is a work in progress.

## Devices

- **Share devices between connected environments.** Share one styal environment's simulators with another from web, desktop, or mobile settings without configuring SSH or choosing an IP address. styal selects a reachable address and tries saved alternatives when needed. Device access persists after the client closes and can be revoked. T3 Code still connects remote device hosts through SSH as of [revision 98a6246](https://github.com/pingdotgg/t3code/tree/98a6246d07624432a6e6d0ab4fb87bede90a49a6). [Use devices from another environment](./devices.md#devices-from-another-environment).

- **Agents hand devices back, and idle simulators shut down.** `device_close` releases a thread's hold on a simulator or emulator so another agent can take it, and a device held by a thread that is not working is handed to the next agent that needs one. An agent cannot open a device another thread is using unless told to take it over, and archived threads release their devices. Simulators styal started stop after a configurable idle period once no working thread holds them and nobody watches them; devices you started yourself keep running. T3 Code never releases an agent's device claim or shuts idle devices down automatically as of [revision 40a7908](https://github.com/pingdotgg/t3code/tree/40a7908df54d5069c93835032c9e955b56b55f1d). [Idle devices](./devices.md#idle-devices).

- **Agents lease network hardware one thread at a time.** Register a device with an HTTP API, such as a microcontroller, and agents read it freely, need a lease to change it, and wait for your approval before actions its repository marks as risky, even in full-access threads. Leases survive between turns, show who holds them, and always run the device's cleanup when they end; scripts reach the leased device through a local proxy. T3 Code has no hardware leases as of [revision 9c16146](https://github.com/pingdotgg/t3code/tree/9c161462c94f7d9d6d9169da5c841457cbadf213). [Hardware](./hardware.md).

## Mobile

- **Android updates inside the app.** styal offers APK updates in **Settings → About styal**,
  downloads them with progress and cancellation, then opens Android's installer. T3 Code has
  over-the-air updates but no in-app APK installer as of
  [revision 454b94a](https://github.com/pingdotgg/t3code/tree/454b94a13aea918f27bb060d8d054d4cfb791bc2).
  [Install and update the mobile app](./install.md#mobile-app).
- **Network reports.** Mobile **Settings → About → Diagnostics** shows how connections held up
  on each network type, with time connected, drops, reconnect times, heartbeat round trips, and
  data used, kept for 7 days. T3 Code has no client-side connection measurement as of
  [revision cfafb4b](https://github.com/pingdotgg/t3code/tree/cfafb4bb54d244e4612f5681aad3832ea64cb0fb).
  [Check how connections held up](./remote-access.md#check-how-connections-held-up).
- **Every provider in Provider accounts.** Mobile **Settings → Provider accounts** lists each
  provider with its icon and sign-in status, including Claude and Codex, which sign in through
  their own CLI. T3 Code lists only providers that sign in inside the app as of
  [revision 7ac952c](https://github.com/pingdotgg/t3code/tree/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae).

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
- **Update checks avoid GitHub's anonymous API quota.** `styal update` and mobile environment
  checks read npm's published version for the host's release channel and reject releases from
  another channel. T3 Code discovers these releases through GitHub's API as of
  [revision ed0f7b9](https://github.com/pingdotgg/t3code/tree/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e);
  an open pull request ([#17900](https://github.com/pingdotgg/t3code/pull/17900)) moves only the
  mobile check to GitHub's release pages. [Updating styal](./updating.md).

## Workspaces and agent sessions

- **Follow-ups steer by default.** Messages sent while an agent is working join
  the active turn. Choose Queue in Follow-up behavior to wait for the turn to finish;
  saved Queue preferences are preserved. T3 Code defaults to Queue as of
  [revision 5753207](https://github.com/pingdotgg/t3code/tree/5753207d53362608f281738eda3a9faf4e13b6be).
  A message's Steer or Queued label sits beside its timestamp and appears on hover on web
  and desktop. T3 Code always shows it above the message on web and as a colored badge on mobile, as of
  [revision adb0420](https://github.com/pingdotgg/t3code/tree/adb04202b25c1c45255e76be9f03f0b346b9c5c4).
  [Send while the agent is working](./composer.md#send-while-the-agent-is-working).

- **Separate Gemini model and reasoning choices.** Antigravity lists each Gemini generation once,
  with a separate reasoning effort control. Existing threads retain their selected effort.
  T3 Code lists thinking variants as separate models as of
  [revision 5cc99e1](https://github.com/pingdotgg/t3code/tree/5cc99e1c23980d7995a13c47f969b47cb68ed1be).
  [Antigravity](./providers-antigravity.md).

- **New threads start on Claude.** When both Claude Code and Codex are available, a new thread
  without a saved or project model uses Claude Code with Opus 5.5, and Claude is listed first in the
  model picker. T3 Code prefers Codex as of
  [revision ed0f7b9](https://github.com/pingdotgg/t3code/tree/ed0f7b908b2e7b3a22e6fd82a73794c2fe6ee06e).

- **Visible Claude history cleanup rules.** Provider settings show each Claude instance's
  user-level session cleanup period and source file, with a link from Usage. Compared with
  [T3 Code revision 42da166](https://github.com/pingdotgg/t3code/tree/42da166d131017335a1158d0b379dd68b8985796).
  [Claude session history cleanup](./providers-claude.md#session-history-cleanup).

- **Claude Code starts with Opus 5.5.** New Claude Code threads select Opus 5.5 when the installed
  CLI supports it; older installations use an available Claude model. T3 Code defaults to Fable 5.1
  as of [revision f5ef0dd](https://github.com/pingdotgg/t3code/tree/f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc0618).
- **Codex starts with GPT-6.1-Sol at medium effort.** New Codex threads select GPT-6.1-Sol when
  available, then GPT-6-Sol, GPT-6-Astra or an older model offered by the installed CLI. T3 Code
  defaults to GPT-6-Astra as of
  [revision 2cbc24f](https://github.com/pingdotgg/t3code/tree/2cbc24fcae2b5649d7b60b68da72053a37fa82d5).
- **Text generation uses a provider you're signed in to.** Thread titles, branch names, and commit
  and pull request text default to Claude Haiku 5.5. When the chosen provider is signed out or not
  installed, styal uses Claude Haiku 5.5, then GPT-6 Luna, then another signed-in provider, and
  **Settings** shows the initial model choice. If a generation request hits a rate or usage limit, styal
  tries another usable provider in the same order without changing your saved model preference.
  T3 Code defaults to GPT-6 Luna and switches only when the provider is turned off as of
  [revision 7ac952c](https://github.com/pingdotgg/t3code/tree/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae).
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
  in new worktrees or when threads settle, and when it replaces an existing setup or settle action. [Project actions](./project-scripts.md). Compared with
  [T3 Code revision 079e4bc](https://github.com/pingdotgg/t3code/tree/079e4bccdcffc56c54bd69523ed77c006553ea21),
  checked October 18, 2026, which imports file actions when selected.
- **Drafts that follow you.** Existing-thread draft text and model settings sync between clients
  connected to the same server. Attachments and other device-specific context stay local; drafts
  containing that context are withheld from other clients to avoid sending an incomplete message.
  [Composer drafts](./composer-drafts.md).

## GitHub and code review

- **PR deployments at a glance.** The pull request Summary shows each environment's latest
  deployment status, with links to open the environment and inspect deployment logs. Compared with
  [T3 Code revision e3b35d1](https://github.com/pingdotgg/t3code/tree/e3b35d1b2440b104f0bc2e357377c348121234dd),
  checked October 16, 2026, which does not show deployments in the pull request panel.
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
- **Agents wait for CI outside pull requests.** T3 Code agents can already watch a pull request and
  wake when its checks finish. styal agents can also watch a single GitHub Actions run, such as CI
  after a merge, a deploy, or a workflow they started, and wake once it completes with the jobs that
  did not pass. [Watch a workflow run](./source-control.md#watch-a-workflow-run).
  Compared with [T3 Code revision 13aa882](https://github.com/pingdotgg/t3code/tree/13aa882c22d584de5388dfce3b3ca413387ba059),
  checked October 17, 2026.

- **Code review findings in the conversation.** When Claude Code's `/code-review` reports its
  findings, they appear as a list with links to each file and line, and stay visible after the turn
  collapses. Copy review copies the full findings, even when their details are
  collapsed. Compared with
  [T3 Code revision f23d008](https://github.com/pingdotgg/t3code/tree/f23d0084b6e023ffb1af9e332d8666affc99d542),
  checked October 11, 2026, where the report is only visible as a collapsed tool call.

## Staying oriented while agents work

- **Switch question answers on mobile without losing your draft.** Choosing a single answer
  keeps your custom text in its question field. The selected option is sent; tap your text to
  use it instead. Compared with
  [T3 Code revision 7ac952c](https://github.com/pingdotgg/t3code/tree/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae),
  checked October 14, 2026, which clears the mobile custom answer when you choose an option.
- **Add your own answer to a multi-select question.** Select the offered options and type an
  addition; both are sent together on web, desktop, and mobile. Compared with
  [T3 Code revision 6524a8d](https://github.com/pingdotgg/t3code/tree/6524a8d43795dc543f7cfb572388cdea3662ad48),
  checked October 13, 2026, which treats selected options and custom text as alternatives.
- **Open links in agent questions.** URLs and Markdown links in pending questions open on web,
  desktop, and mobile without sending an answer. Compared with
  [T3 Code revision 701fc83](https://github.com/pingdotgg/t3code/tree/701fc83169611473139c441bc27d5ded9612dc8d),
  checked October 12, 2026, which displays question bodies as plain text.
- **Unpinning restores settlement immediately.** Pins keep threads active after inactivity or
  a merged review. Unpinning immediately checks whether the thread is finished, while an explicit
  **Un-settle** still keeps it active until new activity. T3 Code also protects pinned threads
  in its newer orchestrator as of
  [revision 4f63275](https://github.com/pingdotgg/t3code/tree/4f63275ac7885281d245022e65f1e9e8816b1382),
  checked October 10, 2026, but unpinning waits for its next settlement sweep.
  [Pin and reorder threads](./thread-sidebar.md#pin-and-reorder-threads).
- **Discard drafts with a swipe on mobile.** New-task drafts support swipe-to-discard with
  confirmation in the thread list and tablet sidebar. T3 Code offers discard from the long-press
  menu as of [revision 98beed1](https://github.com/pingdotgg/t3code/tree/98beed1a226c42b85c52ff5ee9d5dbb67d776a77),
  checked October 10, 2026. [Composer drafts](./composer-drafts.md).
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
- **Model and tokens per turn, and thread totals.** Each completed turn shows the model and
  effort it ran on and the tokens it used beside its timestamp, and the composer and the sidebar's
  thread hover card show the thread's total; hover or tap for the input, cached, output, reasoning, and subagent breakdown,
  and an estimated API cost, which can lead instead of tokens. Compared with
  [T3 Code revision 2a4ee33](https://github.com/pingdotgg/t3code/tree/2a4ee339827e480da6ad0139585cf634a46ff73e),
  checked October 10, 2026, which shows token use and cost only on its Usage page and context
  meter, and names a model in the conversation only where the thread switches models.
  [See what a turn used](./usage.md#see-what-a-turn-used).
- **Optional Discord activity.** The desktop app can share the number of active threads and
  their projects, without sharing names or conversation content. Settled, snoozed, and archived
  threads are excluded. [Discord Rich Presence](./discord-rich-presence.md). Compared with
  [T3 Code revision 9ea9c3d](https://github.com/pingdotgg/t3code/tree/9ea9c3d5d2c444133e3ddff40eecf38737951589),
  checked September 18, 2026, which does not include Rich Presence.
- **A sound choice for each alert.** T3 Code provides fixed completion and attention sounds as of
  [revision 35be904](https://github.com/pingdotgg/t3code/tree/35be904f2fc40aa6d7a42778b6895e8274f3097f).
  styal lets you independently select and preview those sounds, Avanti, or Departures for
  completion, input, and approval alerts, or silence an event. Sounds are on by default; T3 Code
  starts with alerts off. [Completion sounds](./thread-sidebar.md#completion-sounds).
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
  threads. Existing threads retain recorded token use, API cost, tool activity, and checkpoints when
  upgrading to the new history format; T3 Code migrates messages only as of
  [revision de34391](https://github.com/pingdotgg/t3code/tree/de343914273eceb852a1d1d739cd1d38df7796ee). Migration is available during setup and later in Settings; setup reviews differing
  preferences in a separate step.[^import-comparison] Credentials and active sessions remain separate.
  [Import T3 Code data](./importing-t3-code-data.md).

## App updates

- **Refresh when a new web build is available.** The web app and previews detect a new deployment
  and offer a refresh when you are ready, keeping your composer text drafts and saved connections.
  T3 Code has no deployment refresh notice as of
  [revision 42da166](https://github.com/pingdotgg/t3code/tree/42da166d131017335a1158d0b379dd68b8985796).
  [Web app updates](./updating.md#web-app-updates).

- **Updates ready for your next launch.** styal downloads updates in the background and installs
  them when you quit. The sidebar shows an icon only when you can restart to update immediately;
  checks, download progress, and retries are available in Settings.
  [Updating styal](./updating.md). Compared with
  [T3 Code revision 1ab2dfb](https://github.com/pingdotgg/t3code/tree/1ab2dfb5a7bd2996f79407b5d02cae6132a7626c),
  which disables automatic downloads and installation on quit.

- **Confirm only when quitting may interrupt work.** Desktop quits and restarts check agents and
  terminal work across the environments hosted by the app, including work started from other devices
  and agents in other environments using its shared devices.
  Idle hosts proceed without a dialog; active work or an unavailable check requires an in-app confirmation.
  The **Update server** action checks the connected server the same way before it restarts.
  Compared with [T3 Code revision d4d5d12](https://github.com/pingdotgg/t3code/tree/d4d5d12e8ba086cfbf79ca3adeb4156b46ead665),
  whose desktop lifecycle does not check host activity before quitting, and
  [T3 Code revision fd46510](https://github.com/pingdotgg/t3code/tree/fd465100581055383126aab922a8da2c5d7952fd), whose server update action
  does not check activity.

- **Reopen in full screen on macOS.** If styal quits while its window is in full screen, including
  when it restarts to update, it opens in full screen again. Compared with
  [T3 Code revision 18656a3](https://github.com/pingdotgg/t3code/tree/18656a3402459d9d145bb3fa5767723531b27ac7),
  checked October 11, 2026, which reopens a full-screen window at its normal size.

## Provider updates

- **Tested provider updates install themselves.** Each environment installs new Codex, Claude Code,
  and OpenCode releases in the background once an automated check has run real agent turns against
  them, and waits until no threads are running. This covers providers installed with npm or a
  similar package manager. Turn this off in **Settings → General**. T3 Code
  updates providers only when you choose to, as of
  [revision 40a7908](https://github.com/pingdotgg/t3code/tree/40a7908df54d5069c93835032c9e955b56b55f1d);
  automatic installs exist there only as an open pull request
  ([#17585](https://github.com/pingdotgg/t3code/pull/17585)) without a tested-version gate.
  [Automatic provider updates](./updating.md#automatic-provider-updates).

## Error reports

- **Server errors reach the styal maintainers.** Release builds report server errors, scrubbed of
  personal paths and secrets, alongside product usage data so bugs can be found and fixed. Turn
  them off with `T3CODE_ERROR_REPORTING_ENABLED=false`. Compared with
  [T3 Code revision 6524a8d437](https://github.com/pingdotgg/t3code/tree/6524a8d43795dc543f7cfb572388cdea3662ad48),
  checked October 13, 2026, which sends no error reports.
  [Product usage data](./telemetry.md#error-reports).

[^import-comparison]: Setup compared with [T3 Code revision 1ab2dfb](https://github.com/pingdotgg/t3code/tree/1ab2dfb5a7bd2996f79407b5d02cae6132a7626c), checked September 17, 2026.

[^setup-comparison]: Hosted setup compared with [T3 Code revision dfbb11b](https://github.com/pingdotgg/t3code/tree/dfbb11bdd7c3f1a5575cb55d3e3abb12be025727), checked September 19, 2026.
