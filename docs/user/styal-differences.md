# How styal differs from T3 Code

styal builds on T3 Code with its own choices around workspaces, agent sessions, and code review.
This overview highlights additions and refinements compared with
[T3 Code as of September 16, 2026](https://github.com/pingdotgg/t3code/tree/ed123897943e9175d4a0e92a5a8a09d200573336).
The differences evolve as both projects develop.

styal is in active development. The hosted web app at [app.styal.build](https://app.styal.build) is
live, with rough edges and incomplete functionality. Importing T3 Code projects and preferences
works. This overview focuses on desktop and web; the mobile app is a work in progress.

## styal Link sign-in

- **Sign in with an emailed code, and stay signed in.** styal Link signs you in with an eight-digit
  code sent to your email, the same way on web, desktop, mobile, and the command line, where you type
  the code into the terminal. A sign-in lasts while you keep using it, up to 90 days without use,
  and your account lists every signed-in device so you can sign any of them out. T3 Code signs in
  through Clerk, so a sign-in ends when Clerk's maximum session lifetime runs out, as of
  [revision 9c16146](https://github.com/pingdotgg/t3code/tree/9c161462c94f7d9d6d9169da5c841457cbadf213).
  [styal Link](./remote-access.md#styal-link).

## Agent permissions

- **Agents find previous work across machines.** A thread search covers this machine and its linked machines by default, labels results by machine, and reports offline or refused machines. A machine or project can still be searched on its own. Upstream searches one selected machine as of [revision e455200](https://github.com/pingdotgg/t3code/tree/e455200077ce60806a01c8f28435b58860dcfc74), checked November 7, 2026. [Your machines](./remote-access.md#your-machines).

- **Auto agents can prepare work on another machine.** Auto threads can request a link for you to approve, clone repositories, and create projects without scripts or a default model. They can run a scheduled task only within their own mode limits. Changing or deleting projects and changing machine settings still need Full access. Upstream requires Full access for all these operations as of [revision 4bfb896](https://github.com/pingdotgg/t3code/tree/4bfb896d00a130ecf155ac55c24577b32ea49e2e), checked November 5, 2026. [Link another environment](./remote-access.md#link-another-environment).

## Devices

- **Save a simulator memory mode per project.** Low memory prepares unused iOS simulators with a fixed preset before starting them; Standard restores managed services on the next unused start. Web, desktop, mobile, and agents inherit the same project preference. T3 Code has no simulator memory modes as of [revision 725ada6](https://github.com/pingdotgg/t3code/tree/725ada6eaa32d4a32c361ee42a1717a3e65568d1), checked October 25, 2026. [Simulator memory](./devices.md#simulator-memory).

- **Integration setup names every environment.** On web and desktop, the Browser and Devices settings pages list every environment, including disconnected ones, with its own agent browser access or device setup and no project or environment filter. Controls change the environment they appear under; browser preferences apply to the client, and project access overrides live in Projects. T3 Code uses shared scope filters and representative device status as of [revision 9db433f](https://github.com/pingdotgg/t3code/tree/9db433f4bab5dcc923672ef2e6f31f377d39705e). [Settings and project overrides](./project-settings.md).

- **Let two machines work together in one step.** From web, desktop or mobile settings, **Work together** turns on linking, adds each machine to the other with a pairing code it creates itself, and shares devices from whichever machine has them, with a progress list and a way to finish later if a machine is asleep. **Stop working together** removes both links, ends the sessions each gave the other and stops sharing. Web and desktop bring connections and agent access together in **Settings → Machines**, with each machine shown once as a tab and its **Agents on &lt;name&gt; can work on** list always visible. **Add machine** at the top connects this app; **Add machine** within a tab lets its agents work elsewhere. Mobile shows the same tabs and list; adding a machine for another machine's agents stays on web and desktop. Each machine has one setting for what the others can do there: **Can control this machine**, **View only** or **Nothing**. It's enforced by the machine itself, device sharing follows it, and lowering it shows how many threads will stop and asks first, holds their queued messages and ends their watches. T3 Code links one direction at a time with thread mode names as of [revision 072254d](https://github.com/pingdotgg/t3code/tree/072254ddd31dfc01b8ae9336a82d7439125e9ac0), checked November 12, 2026. [Your machines](./remote-access.md#your-machines).

- **Share devices between connected environments.** Share one styal environment's simulators with another from web, desktop, or mobile settings without configuring SSH or choosing an IP address. styal selects a reachable address and tries saved alternatives when needed. Device access persists after the client closes and can be revoked. New remote device setup uses environment sharing; saved SSH hosts remain manageable in a collapsed section. T3 Code connects remote machines through SSH as of [revision 5b35402](https://github.com/pingdotgg/t3code/tree/5b35402623d7d1d88eaa472807272a6c2e78012a). [Use devices from another environment](./devices.md#devices-from-another-environment).

- **Agents hand devices back, and idle simulators shut down.** `device_close` releases a thread's hold on a simulator or emulator so another agent can take it, and a device held by a thread that is not working is handed to the next agent that needs one. An agent cannot open a device another thread is using unless told to take it over, and archived threads release their devices. Simulators styal started stop after a configurable idle period once no working thread holds them and nobody watches them; devices you started yourself keep running. T3 Code never releases an agent's device claim or shuts idle devices down automatically as of [revision 40a7908](https://github.com/pingdotgg/t3code/tree/40a7908df54d5069c93835032c9e955b56b55f1d). [Idle devices](./devices.md#idle-devices).

- **Physical Android phones stay awake, with the screen dark, while in use.** A phone plugged into an environment stays awake while a thread holds it, so its stream never goes black from the phone sleeping, and its screen stays off unless you turn that setting off. Streaming and input keep working, and the phone returns to normal when no thread holds it. T3 Code leaves the phone's screen on and lets it sleep as of [revision 9826dbb](https://github.com/pingdotgg/t3code/tree/9826dbb9904b2591bfbf60d1317486b59132f56b), checked October 28, 2026. [Physical Android devices](./devices.md#physical-android-devices).

- **Agents lease network hardware one thread at a time.** Register a device with an HTTP API, such as a microcontroller, and agents read it freely, need a lease to change it, and wait for your approval before actions its repository marks as risky, even in full-access threads. Leases survive between turns, show who holds them, and always run the device's cleanup when they end; scripts reach the leased device through a local proxy. T3 Code has no hardware leases as of [revision 9c16146](https://github.com/pingdotgg/t3code/tree/9c161462c94f7d9d6d9169da5c841457cbadf213). [Hardware](./hardware.md).

## Mobile

- **New threads follow the project filter.** On mobile, New thread uses the filtered project even when another thread is open. Without a filter or an open thread, it reuses the last valid project automatically; there is no reuse toggle. The contextual keyboard shortcut still prefers the open thread. Upstream ignores the filter as of [revision c6ca605](https://github.com/pingdotgg/t3code/tree/c6ca6056309904f89b90b6055d797973be0a0939), checked November 9, 2026. [Start a thread](./thread-sidebar.md#start-a-thread).

- **Android updates inside the app.** styal offers APK updates in **Settings → About**,
  downloads them with progress and cancellation, then opens Android's installer. T3 Code has
  over-the-air updates but no in-app APK installer as of
  [revision 454b94a](https://github.com/pingdotgg/t3code/tree/454b94a13aea918f27bb060d8d054d4cfb791bc2).
  [Install and update the mobile app](./install.md#mobile-app).
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

- **Free source files without removing worktrees.** An optional per-project, per-machine switch un-checks-out unchanged sources seven days after settlement, preserving root files, local edits, untracked files and nested ignored files and links. Threads and file views show **Source files freed** with **Check out**; sources also return before a turn, terminal, rollback or Git action. Upstream has no automatic in-place un-checkout as of [revision 8cf97b5](https://github.com/pingdotgg/t3code/tree/8cf97b5f06f30a872ce30ab8a888f2ff012365a2), checked November 18, 2026. [Source file cleanup](./project-settings.md#free-source-files-in-settled-worktrees).

- **Settings can show how a feature works.** A setting can open a short walkthrough that draws what the feature does, step by step, from a **See how it works** link under it. It opens by itself once, the first time you turn the setting on, and shows only its last frame when your system asks for reduced motion. **Free source files in settled worktrees** has the first one, on web and desktop. T3 Code has no feature walkthroughs as of [revision a5090a7](https://github.com/pingdotgg/t3code/tree/a5090a75767dfaef311932e4a466e5fe2ee2f0f2), checked November 18, 2026. [Source file cleanup](./project-settings.md#free-source-files-in-settled-worktrees).

- **Keep worktrees while freeing regenerable files.** Projects declare git-ignored paths with `regenerableFiles` in their own `styal.json` on the remote’s default branch (or the configured default or registered checkout’s current branch when there is no remote); cleanup can delete matching paths from settled worktrees at least 24 hours after the last thread activity, settlement or archival unless cleanup is switched off for that project on that machine, and the next turn reruns setup. Upstream has no in-place cleanup as of [revision ba11932](https://github.com/pingdotgg/t3code/tree/ba1193273ad02c4a758b8b1fe9149361b7905170), checked November 17, 2026. [Regenerable files](./project-settings.md#regenerable-files-in-worktrees).

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

- **Interrupted idle compaction has a bounded retry.** A restart can retry an automatic Claude compaction, with a notice when it is skipped. Upstream still cancels it as of [revision 1cefbc4](https://github.com/pingdotgg/t3code/tree/1cefbc4051ba687035b4cca3fa4a59309a8918a9), checked November 18, 2026. [Compact long conversations](./providers-claude.md#compact-long-conversations).

- **Visible Claude history cleanup rules.** Provider settings show each Claude instance's
  user-level session cleanup period and source file, with a link from Usage. Compared with
  [T3 Code revision 42da166](https://github.com/pingdotgg/t3code/tree/42da166d131017335a1158d0b379dd68b8985796).
  [Claude session history cleanup](./providers-claude.md#session-history-cleanup).

- **Claude Code starts with Opus 5.5.** New Claude Code threads select Opus 5.5 when the installed
  CLI supports it; older installations use an available Claude model. T3 Code defaults to Fable 5.1
  as of [revision f5ef0dd](https://github.com/pingdotgg/t3code/tree/f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc0618).
- **Codex starts with GPT-6.2-Sol at medium effort.** New Codex threads select GPT-6.2-Sol when
  available, then GPT-6.1-Sol, GPT-6-Sol, GPT-6-Astra or an older model offered by the installed CLI. T3 Code
  defaults to GPT-6-Astra as of
  [revision e5d757f](https://github.com/pingdotgg/t3code/tree/e5d757f51b342a5ebc50312790e39a1baca61194).
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
  [T3 Code revision 20081ef](https://github.com/pingdotgg/t3code/tree/20081ef95f78b17c1f0e8d9be8bacf28b191bdc9),
  checked November 18, 2026, which runs the action whenever a thread in the worktree settles,
  except a subagent sharing its parent's worktree.

- **Agents know how styal is set up.** Claude, Codex and OpenCode 2 sessions come with a built-in styal skill covering `styal.json`, actions, devices, hardware, imports and troubleshooting, so asking an agent to set these up works without installing anything. It doesn't touch your provider's own skills or settings, and it updates with styal. Other providers read the same guides through a styal tool.

- **Sign in to any provider from styal.** Claude, Grok Build, OpenCode, Pi, fx and Muse Code run their own login from **Settings → Providers**, the mobile provider list, or any thread whose provider is signed out. It works from a phone and on a remote environment, and each machine keeps its own login.

- **Threads continue after sign-in.** A thread stopped because its provider is signed out waits, including a delegated thread and whatever is waiting on it. Sign in from styal or that provider's own CLI and it continues once. **Stop waiting** ends the wait, and it never counts as working.

## GitHub and code review

- **Smaller PR image downloads.** GitHub images served through styal load as resized previews on web, desktop, and mobile. Opening an image reuses the screen-sized preview; choose **View original** for the exact original bytes. Animated images keep playing in their original format. Public GitHub CDN links and repository-relative images retain their existing behavior. Compared with [T3 Code revision 375343a](https://github.com/pingdotgg/t3code/tree/375343aaf35133f659435554cd01634bab333a7d), checked November 16, 2026, which streams the original bytes.

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

- **Documents, web pages and searches the agent used show beside its images.** Under a collapsed tool group, a row of chips names the PDFs and office documents the agent read, the web pages it fetched and the queries it searched, so you can open them without expanding the group. A document opens in the Files panel, a page opens as a chat link does, and a search lists its results. It covers Claude and Codex; pages the reply already links and your own attachments are left out. Upstream shows only images there as of [revision 75cae42](https://github.com/pingdotgg/t3code/tree/75cae42febdbedc2bd39430a1d6f017e38f6bfe0), checked November 18, 2026.

- **Your attachments aren’t repeated in the image strip.** When an agent reads back an image attached to a user message in the same thread, web, desktop and mobile leave it out of the viewed-image strip. Other images the agent reads stay visible beside collapsed tool groups. Upstream repeats attachments there as of [revision 8cf97b5](https://github.com/pingdotgg/t3code/tree/8cf97b5f06f30a872ce30ab8a888f2ff012365a2), checked November 18, 2026.

- **Approvals stay above the message box.** On web and desktop, a pending approval sits above the
  composer with the full command and clearly sized buttons, the same place as an agent's questions,
  so it stays in view however far the conversation scrolls. Its row in the conversation shows that
  it is waiting. T3 Code answers approvals with text buttons on the conversation row. Compared with
  [T3 Code revision 6577c6b](https://github.com/pingdotgg/t3code/tree/6577c6b6185167c0e502fa01f9e8e8f2dee6ff25),
  checked November 6, 2026.

- **Threads an agent starts can report back.** An agent can start a thread that wakes it when the thread fails, stays stuck on an approval or question for two minutes, or finishes a turn with nothing else pending. Turns you started in that thread and turns still waiting on a pull request stay quiet. A thread started on another of your machines can't report back yet. You can stop reports from the thread's details on web and desktop or its menu on mobile. T3 Code has no equivalent as of [revision 6577c6b](https://github.com/pingdotgg/t3code/tree/6577c6b6185167c0e502fa01f9e8e8f2dee6ff25), checked November 6, 2026.

- **A project can have a coordinator.** In Labs, one thread per project can be named its coordinator from the thread's menu or the project's settings. It is told to hand work to other threads, and hears from every thread started in the project, including ones you start, through the same reports. Each project gets a page with that thread as its chat, and the page's first message can create it. On mobile the chat opens as the project's screen, from its row or its project header. Opening the page after a while away lists what finished, failed, merged or was reported since you last looked, on any of your devices. T3 Code has an open Home pull request ([#15975](https://github.com/pingdotgg/t3code/pull/15975)) for one fleet-wide agent thread and no per-project coordinator as of [revision 9899b47](https://github.com/pingdotgg/t3code/tree/9899b4724d14ad1911a228cfebeca35aa6cad8b1), checked November 17, 2026. [Name a project coordinator](./project-settings.md#name-a-project-coordinator).

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
- **Project folders by default.** On web and desktop the sidebar puts active threads in a folder
  for each project, and **Settings → General → Sidebar layout** switches to the flat list. Dragging
  a folder header moves the project, or pins, unpins, or reorders pinned projects; the folder menu
  also archives a project with **Undo**, and archived projects' pull requests leave the **Pull
  requests** page. Compared with
  [T3 Code revision 6927cfe](https://github.com/pingdotgg/t3code/tree/6927cfe2adb0867eb098009a5eb35e42da2b13a1),
  checked November 18, 2026, which keeps folders off behind **Settings → Labs**, without folder
  dragging or archiving, and lists archived projects' pull requests.
  [Project folders](./thread-sidebar.md#project-folders).
- **Compact single-project filters.** On web and desktop, selecting one project names it above search and removes repeated project labels and section headers. Selecting several projects or All projects restores them. Compared with [T3 Code revision d5fc29f](https://github.com/pingdotgg/t3code/tree/d5fc29fe5cb62db68bfbf824cfabe0ae94ac6ac4), checked November 7, 2026, which repeats the project on thread cards. [Filter by project](./thread-sidebar.md#filter-by-project).
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
  [T3 Code revision 6a29d58](https://github.com/pingdotgg/t3code/tree/6a29d58d147522f85112c0c7149f2f9032cd955f),
  checked November 18, 2026, which turns every path-like span into a chip.
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
- **Hold Cmd or Ctrl to see button shortcuts.** On web and desktop, holding Cmd (Ctrl on
  Windows and Linux) shows shortcuts on the buttons they trigger, including ones that also need Shift
  or another modifier; holding that modifier too narrows the hints to the shortcuts that use it. Compared with
  [T3 Code revision c041761](https://github.com/pingdotgg/t3code/tree/c041761d89ef12b8659fc9bf3e98c26eb5140656),
  checked November 14, 2026, which shows these hints only on sidebar threads.
  [Keybindings](./keybindings.md).

## Bringing your work from T3 Code

- **Set up several computers from one Welcome page.** styal's Welcome page is T3 Code's, with
  a Computers band added when more than one computer is available: check saved computers,
  computers linked to your styal Link account (which connect only once checked), or pair one, and
  the page sets up agents and history on each. T3 Code's page sets up only the computer it opens
  on.[^welcome-comparison] [Welcome page](./welcome-page.md#computers).
- **Setup stays focused on new computers.** The hosted app opens the Welcome page on first use,
  waits for live workspace data, and leaves out computers that already contain projects or
  threads. Opening the page from Settings sets up every selected computer. The T3 Code hosted app
  does not open the page; its home page asks you to sign in instead.[^setup-comparison]
- **Choose how threads settle during setup.** A Threads band on the Welcome page explains settling
  and lets you keep or turn off settling on merge and after inactivity before you reach the
  sidebar. T3 Code's Welcome page does not mention settling.[^welcome-comparison]
  [Welcome page](./welcome-page.md#threads).
- **Get the phone app from styal's releases.** The Welcome page's phone section links to the
  newest styal for Android release and says iPhone and iPad use an invite-only TestFlight. T3
  Code's sends phones to its App Store and Google Play apps.[^welcome-comparison]
  [Welcome page](./welcome-page.md#phone).
- **Import without replacing your existing setup.** Bring projects, threads, attachments, and
  supported preferences into styal while leaving the T3 Code installation intact. Existing styal
  project settings take precedence, and interrupted imports can resume without duplicating completed
  threads. Existing threads retain recorded token use, API cost, tool activity, and checkpoints when
  upgrading to the new history format; T3 Code migrates messages only as of
  [revision de34391](https://github.com/pingdotgg/t3code/tree/de343914273eceb852a1d1d739cd1d38df7796ee). Migration is its own choice on the Welcome page, with projects and differing
  preferences checked separately, and is available later in Settings.[^import-comparison] Credentials and active sessions remain separate.
  [Import T3 Code data](./importing-t3-code-data.md).

- **A recovery copy before history pruning.** History pruning stays off unless enabled. When enabled, styal keeps imported and migrated history readable after older internal events are pruned, and requires a verified database copy before the first prune. The first start may take longer while the copy is made; without enough disk space, styal starts without pruning. The copy stays for seven days after the first deletion completes. T3 Code prunes without this safety copy as of [revision 25bf84a](https://github.com/pingdotgg/t3code/tree/25bf84ab07f53f141c20239c63e383823a9d5ea0). [Restore the safety copy](./background-service.md#safety-copy-before-history-pruning).

## App updates

- **Refresh when a new web build is available.** The web app and previews detect a new deployment
  and offer a refresh when you are ready, keeping your composer text drafts and saved connections.
  T3 Code has no deployment refresh notice as of
  [revision 42da166](https://github.com/pingdotgg/t3code/tree/42da166d131017335a1158d0b379dd68b8985796).
  [Web app updates](./updating.md#web-app-updates).

- **Desktop update checks run hourly.** Downloads wait for your click. styal checks
  hourly rather than T3 Code's four hours, keeping Nightly offers fresh without
  downloading them. Download checks the latest release again. A finished download
  stays ready while automatic checks pause; Restart to Install installs it without
  another check or download. Downloaded updates install on quit, and macOS prepares
  the installer after download when permissions allow. After a newer release on the same track,
  the app names the version and links to its release notes.
  [Updating styal](./updating.md#desktop-app-updates). Compared with
  [T3 Code revision 1852121](https://github.com/pingdotgg/t3code/tree/1852121afac633f7b4dd85e4965f679e66de21dd),
  checked November 19, 2026, which checks every four hours and requires an explicit
  install. Its Install action can download a newer release before restarting.

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

- **Install a pull request's preview build from its panel.** On an Apple Silicon Mac, **Install and
  open** downloads the build, checks its digest, installs `styal (Preview)`, and opens it, with no
  disk image to mount or quarantine to clear. A newer build replaces it and closing the pull request
  removes it. T3 Code builds macOS previews but has no in-app install as of
  [revision 25b5329](https://github.com/pingdotgg/t3code/tree/25b53299b7).
  [Try a pull request's preview](./updating.md#try-a-pull-requests-preview).

## Provider updates

- **Automatically install styal-tested provider updates.** Each environment manages its provider CLI versions: it installs new
  Codex, Claude Code, and OpenCode releases in the background only after an automated check has run
  real agent turns against them, once none of that provider's own threads are running. Checks
  include an older nightly, so provider updates can reach environments that have not installed the
  newest styal build. Refreshing provider status also checks for approved updates immediately.
  This covers
  providers installed with npm or a similar package manager, native Claude Code on macOS, Linux,
  and Windows, and native Codex and OpenCode 2 on macOS and Linux. WinGet and unrecognized native
  install locations are excluded. For native Claude Code and Codex, styal manages updates in
  place of the provider's own updater. Turn this off in
  **Settings → Maintenance**. T3 Code
  updates providers only when you choose to, as of
  [revision 25bf84a](https://github.com/pingdotgg/t3code/tree/25bf84ab07f53f141c20239c63e383823a9d5ea0);
  automatic installs exist there only as an open pull request
  ([#17585](https://github.com/pingdotgg/t3code/pull/17585)) without a tested-version gate.
  [Automatically install styal-tested provider updates](./updating.md#automatically-install-styal-tested-provider-updates).

## Product data and error reports

- **Product data goes to styal.** Usage events use upstream's feature and tool counts, with provider send, update and stall reports and device stream quality summaries, sent to styal's PostHog project. Compared with [T3 Code revision ee2cddf](https://github.com/pingdotgg/t3code/tree/ee2cddf357a), checked November 14, 2026. [Product usage data](./telemetry.md).

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

[^setup-comparison]: Hosted setup compared with [T3 Code revision 4f0b74e](https://github.com/pingdotgg/t3code/tree/4f0b74e190261c8233ae52af17b0fd1734e99e50), checked November 17, 2026.

[^welcome-comparison]: Welcome page compared with [T3 Code revision 4f0b74e](https://github.com/pingdotgg/t3code/tree/4f0b74e190261c8233ae52af17b0fd1734e99e50), checked November 17, 2026.

## Agent reports

Experimental [agent reports](chat-timeline.md#agent-reports) keep full decision reports in the chat and open questions above the composer until answered, dismissed, or replaced. Compared with upstream `5da89cfcebaa57cd77ae1b2546462f7ac501f42a`, which has no equivalent report tool.
