# How styal differs from T3 Code

styal builds on T3 Code with its own choices around workspaces, agent sessions, and code review.
This overview highlights additions and refinements compared with
[T3 Code as of September 16, 2026](https://github.com/pingdotgg/t3code/tree/ed123897943e9175d4a0e92a5a8a09d200573336).
The differences evolve as both projects develop.

styal is in active development. The hosted web app at [app.styal.build](https://app.styal.build) is
live, with rough edges and incomplete functionality. Importing T3 Code projects and preferences
works. This overview focuses on desktop and web; the mobile app is a work in progress.

## Agent permissions

- **Auto agents can prepare work on another machine.** Auto threads can request a link for you to approve, clone repositories, and create projects without scripts or a default model. They can run a scheduled task only within their own mode limits. Changing or deleting projects and changing machine settings still need Full access. Upstream requires Full access for all these operations as of [revision 4bfb896](https://github.com/pingdotgg/t3code/tree/4bfb896d00a130ecf155ac55c24577b32ea49e2e), checked November 5, 2026. [Link another environment](./remote-access.md#link-another-environment).

## Devices

- **Save a simulator memory mode per project.** Low memory prepares unused iOS simulators with a fixed preset before starting them; Standard restores managed services on the next unused start. Web, desktop, mobile, and agents inherit the same project preference. T3 Code has no simulator memory modes as of [revision 725ada6](https://github.com/pingdotgg/t3code/tree/725ada6eaa32d4a32c361ee42a1717a3e65568d1), checked October 25, 2026. [Simulator memory](./devices.md#simulator-memory).

- **Integration setup names every environment.** On web and desktop, the Browser and Devices settings pages list every environment, including disconnected ones, with its own agent browser access or device setup and no project or environment filter. Controls change the environment they appear under; browser preferences apply to the client, and project access overrides live in Projects. T3 Code uses shared scope filters and representative device status as of [revision 9db433f](https://github.com/pingdotgg/t3code/tree/9db433f4bab5dcc923672ef2e6f31f377d39705e). [Settings and project overrides](./project-settings.md).

- **Let two machines work together in one step.** From web, desktop or mobile settings, **Work together** turns on linking, adds each machine to the other with a pairing code it creates itself, and shares devices from whichever machine has them, with a progress list and a way to finish later if a machine is asleep. **Stop working together** removes both links, ends the sessions each gave the other and stops sharing. Clients also call these machines **Your machines** and reserve "link" for styal Link. Each machine has one setting for what the others can do there: **Can control this machine**, **View only** or **Nothing**. It's enforced by the machine itself, device sharing follows it, and lowering it shows how many threads will stop and asks first, holds their queued messages and ends their watches. T3 Code links one direction at a time with thread mode names as of [revision b46abbf](https://github.com/pingdotgg/t3code/tree/b46abbf3deb39020a86faa9479dd1d022711d3f6). [Your machines](./remote-access.md#your-machines).

- **Share devices between connected environments.** Share one styal environment's simulators with another from web, desktop, or mobile settings without configuring SSH or choosing an IP address. styal selects a reachable address and tries saved alternatives when needed. Device access persists after the client closes and can be revoked. New remote device setup uses environment sharing; saved SSH hosts remain manageable in a collapsed section. T3 Code connects remote machines through SSH as of [revision 5b35402](https://github.com/pingdotgg/t3code/tree/5b35402623d7d1d88eaa472807272a6c2e78012a). [Use devices from another environment](./devices.md#devices-from-another-environment).

- **Agents hand devices back, and idle simulators shut down.** `device_close` releases a thread's hold on a simulator or emulator so another agent can take it, and a device held by a thread that is not working is handed to the next agent that needs one. An agent cannot open a device another thread is using unless told to take it over, and archived threads release their devices. Simulators styal started stop after a configurable idle period once no working thread holds them and nobody watches them; devices you started yourself keep running. T3 Code never releases an agent's device claim or shuts idle devices down automatically as of [revision 40a7908](https://github.com/pingdotgg/t3code/tree/40a7908df54d5069c93835032c9e955b56b55f1d). [Idle devices](./devices.md#idle-devices).

- **Physical Android phones stay awake, with the screen dark, while in use.** A phone plugged into an environment stays awake while a thread holds it, so its stream never goes black from the phone sleeping, and its screen stays off unless you turn that setting off. Streaming and input keep working, and the phone returns to normal when no thread holds it. T3 Code leaves the phone's screen on and lets it sleep as of [revision 9826dbb](https://github.com/pingdotgg/t3code/tree/9826dbb9904b2591bfbf60d1317486b59132f56b), checked October 28, 2026. [Physical Android devices](./devices.md#physical-android-devices).

- **Agents lease network hardware one thread at a time.** Register a device with an HTTP API, such as a microcontroller, and agents read it freely, need a lease to change it, and wait for your approval before actions its repository marks as risky, even in full-access threads. Leases survive between turns, show who holds them, and always run the device's cleanup when they end; scripts reach the leased device through a local proxy. T3 Code has no hardware leases as of [revision 9c16146](https://github.com/pingdotgg/t3code/tree/9c161462c94f7d9d6d9169da5c841457cbadf213). [Hardware](./hardware.md).

## Mobile

- **Android updates inside the app.** styal offers APK updates in **Settings → About**,
  downloads them with progress and cancellation, then opens Android's installer. T3 Code has
  over-the-air updates but no in-app APK installer as of
  [revision 454b94a](https://github.com/pingdotgg/t3code/tree/454b94a13aea918f27bb060d8d054d4cfb791bc2).
  [Install and update the mobile app](./install.md#mobile-app).
- **Network reports.** Mobile **Settings → About → Diagnostics** shows how connections held up
  on each network type, with time connected, drops, reconnect times, heartbeat round trips, and
  data used, kept for 7 days. T3 Code has no client-side connection measurement as of
  [revision cfafb4b](https://github.com/pingdotgg/t3code/tree/cfafb4bb54d244e4612f5681aad3832ea64cb0fb).
  [Check how connections held up](./remote-access.md#check-how-connections-held-up).
- **Choose which agent alerts reach your phone.** Mobile **Settings → Notifications** has a
  switch for each alert type: needs approval, needs input, done, and failed. T3 Code sends
  every type to every registered phone as of
  [revision 9826dbb](https://github.com/pingdotgg/t3code/tree/9826dbb9904b2591bfbf60d1317486b59132f56b).
  [Mobile notifications](./mobile-notifications.md).
- **Phone alerts wait while you're at a computer.** While you're using styal on a computer,
  agent alerts reach your phone after a delay you choose (10 minutes by default), and are
  skipped if you handle or open the thread on the computer first. T3 Code pushes every alert
  immediately as of
  [revision a42bdd4](https://github.com/pingdotgg/t3code/tree/a42bdd4e516433a16650b9401ab3c066544ca5cd).
  [Mobile notifications](./mobile-notifications.md).
- **Every provider in Providers.** Mobile **Settings → Providers** lists each
  provider with its icon and sign-in status, including Claude and Codex, which sign in through
  their own CLI. T3 Code lists only providers that sign in inside the app as of
  [revision 7ac952c](https://github.com/pingdotgg/t3code/tree/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae).
- **Share into an existing thread.** Sharing an image, file or text to the mobile app from
  another app offers your recent threads as well as projects. Choosing a thread adds the content
  to that thread's draft so you can write a message before sending. T3 Code starts a new thread for
  every share as of
  [revision 37fbefd](https://github.com/pingdotgg/t3code/tree/37fbefd147197fab9d88f9c120560c3f21b52cfc),
  checked October 29, 2026. [Attach files](./composer.md#attach-files).

## Command line

- **Explicit startup and styal Link naming.** Running `styal` without a subcommand shows command
  guidance; use `styal start` for the browser-opening server or `styal serve` for a headless host.
  styal also exposes its managed remote-access setup as `styal link` and `styal up --link`, while
  accepting the upstream `connect` spelling as a compatibility alias on the `link` command. [Install styal](./install.md) and
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

- **Agents can wait for a group of delegated tasks.** An agent that delegates several tasks can ask
  to be woken once, when all of them have finished, instead of once per task. A failed task or a
  question from a child still wakes it early, and an optional timeout wakes it with the tasks that
  are still running. T3 Code wakes the parent once per finished task as of
  [revision a42bdd4](https://github.com/pingdotgg/t3code/tree/a42bdd4e516433a16650b9401ab3c066544ca5cd),
  checked October 29, 2026.

- **An Auto default fits each provider.** With **Auto** as the default for new threads, Claude,
  Codex, and Grok threads start in **Auto**, where the provider's own reviewer approves routine
  actions, and providers without automatic review start in **Full access** instead of asking about
  every action. In T3 Code an Auto default makes those providers ask, as of
  [revision 30afc56](https://github.com/pingdotgg/t3code/tree/30afc56076c86580d5d913897280bea660d44c79).
  [Permission modes](./permission-modes.md).

- **Blocked Claude actions say why.** When Claude's Auto mode review or permission settings stop a
  tool call without asking, the conversation marks it blocked, with Claude's reason when it gives
  one. T3 Code shows these as failed tool calls as of
  [revision 0847a44](https://github.com/pingdotgg/t3code/tree/0847a448fdca5a688720050ca706cbbd37e6347e).
  [Permission modes](./permission-modes.md#provider-differences).

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
- **Text generation switches to a provider you're signed in to.** When the provider chosen for
  thread titles, branch names, and commit and pull request text is signed out or not installed,
  styal uses GPT-6 Luna, then Claude Haiku 5.5, then another signed-in provider, and **Settings**
  shows the model that will run. If a request hits a rate or usage limit, styal tries the next usable
  provider in the same order without changing your saved model preference. T3 Code switches only
  when the provider is turned off as of
  [revision e340aae](https://github.com/pingdotgg/t3code/tree/e340aaeeb98bc6ac623c2e70ac8eca8bcbddfe1b).
- **New threads start in a worktree.** Both apps support isolated Git worktrees. After project,
  environment, and project file settings, styal defaults to a worktree when the project is a Git
  repository with a commit or a default branch, and the current checkout otherwise. T3 Code defaults to the local
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
- **Shared actions live in `styal.json`.** Actions declared in a repository's `styal.json` appear
  in every thread of the project as soon as the file changes, with stable ids for shortcuts, and
  you can keep your own edited version of one without changing the file. One only runs when a
  worktree is created or a thread settles after you approve its exact command. A `t3.json` still supplies its settings, and selecting one of its scripts opens it
  for review before saving a local copy. [Project actions](./project-scripts.md#share-actions-with-styaljson).
  Compared with
  [T3 Code revision 680152e](https://github.com/pingdotgg/t3code/tree/680152e27b2a961686389ca69a1557cbb2c55f08),
  checked October 21, 2026, which reads only `t3.json` and imports its scripts as copies.
- **Settle actions wait for the last thread in a worktree.** A worktree shared by several threads
  runs its settle action when the last open thread settles, and never while a thread there is
  working. An idle subagent does not hold it back. [Project actions](./project-scripts.md).
  Compared with
  [T3 Code revision b9522c8](https://github.com/pingdotgg/t3code/tree/b9522c845b06cb8c852c28e9fa747c6335e9f6b3),
  checked November 5, 2026, which runs the action whenever any thread in the worktree settles.

- **Agents know how styal is set up.** Claude, Codex and OpenCode 2 sessions come with a built-in styal skill covering `styal.json`, actions, devices, hardware, imports and troubleshooting, so asking an agent to set these up works without installing anything. It doesn't touch your provider's own skills or settings, and it updates with styal. Other providers read the same guides through a styal tool.

- **Sign in to any provider from styal.** Claude, Grok Build, OpenCode, Pi, fx and Muse Code run their own login from **Settings → Providers**, the mobile provider list, or the thread a signed-out provider stopped. It works from a phone and on a remote environment, and each machine keeps its own login.

- **Threads continue after sign-in.** A thread stopped because its provider is signed out waits, including a delegated thread and whatever is waiting on it. Sign in from styal or that provider's own CLI and it continues once. **Stop waiting** ends the wait, and it never counts as working.

## GitHub and code review

- **PR deployments at a glance.** The pull request Summary, and the pull request screen on mobile,
  show each environment's latest deployment status, with links to open the environment and inspect
  deployment logs. Compared with
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
- **Bypass merge for repository administrators.** When GitHub lets you bypass a repository's rules,
  a pull request blocked on checks or reviews offers **Bypass rules and merge** beside auto-merge.
  Anyone else sees only auto-merge, since GitHub would refuse their merge.
  [Review and merge](./source-control.md#review-and-merge).
  Compared with [T3 Code revision b424c6e](https://github.com/pingdotgg/t3code/tree/b424c6e429f189067897de45d7445d900feadc6a),
  checked October 26, 2026, which offers Merge now on blocked pull requests to everyone.
- **Workflows waiting for approval on release pull requests.** T3 Code shows and approves fork
  workflows waiting for a maintainer. styal also finds runs GitHub holds on pull requests a
  workflow opened with `GITHUB_TOKEN`, such as Changesets release pull requests, offers
  **Approve workflows to run** for them, and wakes a watching agent when runs wait for approval.
  [Review and merge](./source-control.md#review-and-merge).
  Compared with [T3 Code revision 60b35a1](https://github.com/pingdotgg/t3code/tree/60b35a1ee02d717009ff4a3de34de285db9e8a60),
  checked October 22, 2026, which looks for waiting runs on fork pull requests only.
- **Agents wait for CI outside pull requests.** T3 Code agents can already watch a pull request and
  wake when its checks finish. styal agents can also watch a single GitHub Actions run, such as CI
  after a merge, a deploy, or a workflow they started. They wake as soon as a job fails, and again when
  the run completes. A watched run that waits for your deployment review asks for it in the thread.
  [Watch a workflow run](./source-control.md#watch-a-workflow-run).
  Compared with [T3 Code revision 13aa882](https://github.com/pingdotgg/t3code/tree/13aa882c22d584de5388dfce3b3ca413387ba059),
  checked October 17, 2026.

- **Code review findings in the conversation.** When Claude Code's `/code-review` reports its
  findings, they appear as a list with links to each file and line, and stay visible after the turn
  collapses. Copy review copies the full findings, even when their details are
  collapsed. Compared with
  [T3 Code revision f23d008](https://github.com/pingdotgg/t3code/tree/f23d0084b6e023ffb1af9e332d8666affc99d542),
  checked October 11, 2026, where the report is only visible as a collapsed tool call.

## Staying oriented while agents work

- **Approvals stay above the message box.** On web and desktop, a pending approval sits above the
  composer with the full command and clearly sized buttons, the same place as an agent's questions,
  so it stays in view however far the conversation scrolls. Its row in the conversation shows that
  it is waiting. T3 Code answers approvals with text buttons on the conversation row. Compared with
  [T3 Code revision 6577c6b](https://github.com/pingdotgg/t3code/tree/6577c6b6185167c0e502fa01f9e8e8f2dee6ff25),
  checked November 6, 2026.

- **Threads an agent starts can report back.** An agent can start a thread that wakes it when the thread fails, stays stuck on an approval or question for two minutes, or finishes a turn with nothing else pending. Turns you started in that thread and turns still waiting on a pull request stay quiet. A thread started on another of your machines can't report back yet. You can stop reports from the thread's details on web and desktop or its menu on mobile. T3 Code has no equivalent as of [revision 6577c6b](https://github.com/pingdotgg/t3code/tree/6577c6b6185167c0e502fa01f9e8e8f2dee6ff25), checked November 6, 2026.

- **Warnings for agents that may be stuck.** styal records prolonged startup or inactivity in
  the thread's activity log and shows the warning on web, desktop, and mobile. The notice updates
  when activity resumes or the turn ends; the agent is never automatically retried. Compared
  with [T3 Code revision d53873b](https://github.com/pingdotgg/t3code/tree/d53873b6a4799e87afd63c8d288ef0089f5a3748),
  checked October 24, 2026. [When an agent may be stuck](./activity-log.md#when-an-agent-may-be-stuck).

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
- **See why a thread settled.** Threads that settle automatically say why in the Settled shelf,
  such as the merged pull request or **Idle 3 days**, and web and desktop explain the first automatic
  settles once with a link to the settings that control them. T3 Code settles threads
  automatically without recording a reason as of
  [revision 67c0fc0](https://github.com/pingdotgg/t3code/tree/67c0fc0cdaf963b103518862dd7b68a9c758ecf2),
  checked October 20, 2026. [Settle finished work](./thread-sidebar.md#settle-finished-work).
- **Choose what thread times mean.** The sidebar defaults to when you last prompted the agent;
  Settings can instead show the latest message, including agent replies. This changes the time
  shown without rearranging threads. Compared with
  [T3 Code revision d2c9281](https://github.com/pingdotgg/t3code/tree/d2c9281b8112dc3b2991642c4bdb985e4b08b9bb),
  which shows the last user message without this choice. [Working with threads](./thread-sidebar.md).
- **Pin and archive projects from grouped headers.** T3 Code also has project pins and archives. With threads grouped by project, styal adds dragging a header to pin it, unpin it, or change the order of pinned projects, and archiving from the header menu with **Undo**. Archived projects' pull requests also leave the **Pull requests** page. Compared with
  [T3 Code revision ffaa1db](https://github.com/pingdotgg/t3code/tree/ffaa1dba76d86c073533055e48d7f8f015c8a7b7),
  which keeps pins in your project sort order and lists archived projects' pull requests.
  [Pin and archive projects](./project-settings.md#pin-and-archive-projects).
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
  starts with alerts off. Completion sounds stay quiet for the thread open in a visible, focused window; background tabs and unfocused windows still sound. Upstream sounds viewed completions as of [revision b90e554](https://github.com/pingdotgg/t3code/tree/b90e554e0a942605c4de2d4ff5d4654caf998e27), checked November 6, 2026. [Completion sounds](./thread-sidebar.md#completion-sounds).
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
  when the agent's machine runs in another zone. An optional model check of each reply keeps
  lengths and example times plain and uses the day the reply describes. Compared with
  [T3 Code revision 5cc99e1](https://github.com/pingdotgg/t3code/tree/5cc99e1c23980d7995a13c47f969b47cb68ed1be),
  checked October 1, 2026, which shows these times as plain text.
  [Reading the chat timeline](./chat-timeline.md).
- **Complete conversation export.** Copy a thread's user and assistant messages as Markdown,
  including history that is not currently loaded in the view.
  [Transcripts](./thread-sidebar.md#copying-a-transcript).
- **Paths that open nothing stay plain code.** A path an agent writes in code formatting
  becomes a file chip only when it exists or, when shortened, matches one project file; otherwise
  it stays plain code instead of a chip that opens a missing file. Compared with
  [T3 Code revision 3ddd398](https://github.com/pingdotgg/t3code/tree/3ddd3989e03e44c0106c6e3e44033a2f5b8b50ae),
  checked November 3, 2026, which turns every path-like span into a chip.
  [Reading the chat timeline](./chat-timeline.md).
- **Floating previews stay out of the way of your text.** A floating browser or device preview
  can sit anywhere over the conversation, and moving or resizing it never shifts or narrows the
  messages or the composer. It still keeps clear of the composer and the thread details card.
  Compared with
  [T3 Code revision 7fd2e09](https://github.com/pingdotgg/t3code/tree/7fd2e09e381a61f427da09dd7a8f2c9c1558fe59),
  checked October 25, 2026, which keeps the preview beside the conversation and narrows chat to
  make room.

- **See all your keyboard shortcuts in one place.** Press `mod+?` on web or desktop for a list of
  your own bindings, grouped by area, with a link to change them. Compared with
  [T3 Code revision 4b87a45](https://github.com/pingdotgg/t3code/tree/4b87a45770d24a47f7e6bc40e3f19011e41c7724),
  checked November 5, 2026, which shows shortcuts beside command palette items and in Settings.
  [Keybindings](./keybindings.md).

## Bringing your work from T3 Code

- **Setup stays focused on new computers.** The hosted app opens setup on first use, waits for
  live workspace data, and skips Agents and Import for computers that already contain projects or
  threads. An explicit visit to `/welcome` still reopens the complete setup flow. The T3 Code
  hosted app does not open setup; its home page asks you to sign in instead.[^setup-comparison]
- **Choose how threads settle during setup.** A Workflow step explains settling and lets
  you keep or turn off settling on merge and after inactivity before you reach the sidebar. T3 Code
  setup does not mention settling as of
  [revision 67c0fc0](https://github.com/pingdotgg/t3code/tree/67c0fc0cdaf963b103518862dd7b68a9c758ecf2),
  checked October 20, 2026. [Welcome wizard](./welcome-wizard.md#choose-your-workflow-defaults).
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
  checks, download progress, and retries are available in Settings. After an update, the desktop
  app names the version it now runs and links to its release notes.
  [Updating styal](./updating.md#desktop-app-updates). Compared with
  [T3 Code revision 1ab2dfb](https://github.com/pingdotgg/t3code/tree/1ab2dfb5a7bd2996f79407b5d02cae6132a7626c),
  which disables automatic downloads and installation on quit, and
  [revision 680152e](https://github.com/pingdotgg/t3code/tree/680152e27b2a961686389ca69a1557cbb2c55f08),
  which shows no notice after an update.

- **Confirm only when quitting may interrupt work.** Desktop quits and restarts check agents and
  terminal work across the environments hosted by the app, including work started from other devices
  and agents in other environments using its shared devices.
  Updates and restarts proceed without a dialog when all active threads will resume and no other work
  would be interrupted. Quit still asks about active work. Terminal commands, other interruptions,
  and an unavailable check require confirmation.
  The **Update server** action checks the connected server the same way before it restarts.
  Compared with [T3 Code revision d4d5d12](https://github.com/pingdotgg/t3code/tree/d4d5d12e8ba086cfbf79ca3adeb4156b46ead665),
  whose desktop lifecycle does not check host activity before quitting, and
  [T3 Code revision fd46510](https://github.com/pingdotgg/t3code/tree/fd465100581055383126aab922a8da2c5d7952fd), whose server update action
  does not check activity.

  Combined updates show one detailed confirmation for local and remote work that needs
  attention, then restart this app after the remote handoffs without a countdown.
  Compared with [T3 Code revision 5b35402](https://github.com/pingdotgg/t3code/tree/5b35402623d7d1d88eaa472807272a6c2e78012a),
  checked October 25, 2026, whose combined update dialog shows thread counts and adds a restart countdown.

- **Reopen in full screen on macOS.** If styal quits while its window is in full screen, including
  when it restarts to update, it opens in full screen again. Compared with
  [T3 Code revision 18656a3](https://github.com/pingdotgg/t3code/tree/18656a3402459d9d145bb3fa5767723531b27ac7),
  checked October 11, 2026, which reopens a full-screen window at its normal size.

- **Install a pull request's preview build from its panel.** On an Apple Silicon Mac, **Install and
  open** downloads the build, checks its digest, installs `styal (Preview)`, and opens it, with no
  disk image to mount or quarantine to clear. A newer build replaces it and closing the pull request
  removes it. T3 Code builds macOS previews but has no in-app install as of
  [revision 25b5329](https://github.com/pingdotgg/t3code/tree/25b53299b7).
  [Try a pull request's preview](./updating.md#try-a-pull-requests-preview).

## Provider updates

- **styal managed updates.** Each environment manages its provider CLI versions: it installs new
  Codex, Claude Code, and OpenCode releases in the background only after an automated check has run
  real agent turns against them, once none of that provider's own threads are running. This covers
  providers installed with npm or a similar package manager, native Claude Code on macOS, Linux,
  and Windows, and native Codex and OpenCode 2 on macOS and Linux. WinGet and unrecognized native
  install locations are excluded. For native Claude Code and Codex, styal manages updates in
  place of the provider's own updater. Turn this off in
  **Settings → Maintenance**. T3 Code
  updates providers only when you choose to, as of
  [revision d0b9e9d](https://github.com/pingdotgg/t3code/tree/d0b9e9d3c72b83bb92670fc1fa3afac5bf60e4e8);
  automatic installs exist there only as an open pull request
  ([#17585](https://github.com/pingdotgg/t3code/pull/17585)) without a tested-version gate.
  [styal managed updates](./updating.md#styal-managed-updates).

## Error reports

- **Report a bug from inside the app.** Ask an agent or use **Send feedback**. It posts a public
  issue on styal's repository under your GitHub sign-in, and an agent's report needs your approval
  first. Compared with
  [T3 Code revision 6524a8d437](https://github.com/pingdotgg/t3code/tree/6524a8d43795dc543f7cfb572388cdea3662ad48),
  checked November 5, 2026 by searching its pull requests and issues, which has no such route for
  its own bugs.

- **Server errors reach the styal maintainers.** Release builds report server errors, scrubbed of
  personal paths and secrets, alongside product usage data so bugs can be found and fixed. Turn
  them off with `T3CODE_ERROR_REPORTING_ENABLED=false`. Compared with
  [T3 Code revision 6524a8d437](https://github.com/pingdotgg/t3code/tree/6524a8d43795dc543f7cfb572388cdea3662ad48),
  checked October 13, 2026, which sends no error reports.
  [Product usage data](./telemetry.md#error-reports).

[^import-comparison]: Setup compared with [T3 Code revision 1ab2dfb](https://github.com/pingdotgg/t3code/tree/1ab2dfb5a7bd2996f79407b5d02cae6132a7626c), checked September 17, 2026.

[^setup-comparison]: Hosted setup compared with [T3 Code revision e37a7a4](https://github.com/pingdotgg/t3code/tree/e37a7a4f71cb20c483e101e13d57ccf3598ab832), checked October 28, 2026.
