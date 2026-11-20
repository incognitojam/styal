# Settings and project overrides

On web and desktop, the "Applying settings for …" sentence at the top of Settings pages picks
the project and environment a change applies to. Pages that only hold device preferences, such as
Appearance, don't show it. Browser and Devices list every environment explicitly and have no scope
filters.
The filters start at **All projects** and **All environments**
and stay selected as you move between categories or search for a setting.

Preferences saved on this device, such as appearance, confirmations and browser profiles, always
show and ignore the selection. Everything else is stored on a server. Choose one environment to
edit its settings, or leave **All environments** to edit every connected environment at once.
Offline environments keep their current values; this is a bulk edit, not a synced global default.

Choose a project to override settings for it on the selected environments. A layers icon beside
each server row's title shows where the value comes from: the built-in default, the environment,
or a project override. Click it to see that chain on every selected environment. An override can
be reset to inherit again. Settings that cannot be overridden by a project are shown read-only
while a project is selected.

When the selected environments disagree, the control shows **Mixed** in place of a value and the
layers icon turns amber. Picking a value applies it to every selected environment.

Changing an environment value never touches a project's own override. When projects override the
setting you are editing, the layers icon counts them and the chain lists each one with its value:
click a project to jump to it, or **Reset all** to make those projects follow the environment
again.

Providers and diagnostics are per machine: they show one environment at a time, the primary
one until you pick another. Browser and Devices show each environment's setup and change only the
environment whose controls you use. Other server settings fan out to the selection.

With a project selected, a provider's switch in **Settings → Providers** turns it on or off for
that project only, in either direction: a provider off on the machine can be used in one project,
and one on everywhere can be kept out of another. That project's model pickers follow the switch,
and no new turn there can start on a provider it turned off, including queued messages and
follow-ups from delegated tasks. A turn already running when the switch flips finishes. A delegated
task's result still lands in its parent thread, which sees it on its next turn. Reset returns the project to the
machine's setting. Every other provider setting stays per machine.

On mobile, open **Settings** and use the filter in its header to choose connected environments
and a project. The filter stays available in server-setting pages. With **All projects** selected,
the server-setting pages, such as Threads, Source control and Worktrees, edit the selected
environments' defaults. Choosing a project edits its overrides on the selected
environments. Use **Use defaults** in a page to remove that page's project overrides.
Open **Settings → Projects** to rename the project across its selected
connected checkouts and see where those checkouts live.
Settings that are environment-wide stay read-only while a project is selected. When selected
targets disagree, a control shows **Mixed** until you choose one value. Appearance, keyboard,
and other phone-only settings ignore the filter.

## Pin and archive projects

Pinned projects come first in the project pickers: the project picker on a new thread, the
new-thread list, the command palette, the sidebar project filter, and mobile. In the sidebar, pinned projects get the top
folders, even with no active threads. Pin or unpin a project from its row in any of those lists,
or press the thread pin shortcut (`mod+shift+p` by default) on the highlighted row. **Pin
project** in the command palette and **Settings → Projects** work too. A list keeps its order
while it is open, so a new pin moves up the next time you open it.

Archive a project you are done with in **Settings → Projects**. It leaves the project pickers.
Its threads, settings, and files stay as they are, and archived projects still show in the
Settings project list, marked **Archived**. Choose one there and select **Unarchive** to bring it
back. On mobile, both are in **Settings → Projects → Organize**.

A project on several machines must have every machine connected to pin or archive it.

With [project folders](./thread-sidebar.md#project-folders), you can also drag a folder's header to pin it, unpin it, or change the order of pinned projects, and right-click the folder to archive it. Archived projects' pull requests leave the **Pull requests** page.

## Worktree branch names

In **Settings → Worktrees → Worktree branch naming**, choose a static prefix,
a model-selected semantic prefix such as `feat/` or `fix/`, or custom instructions
for the complete name. The static prefix defaults to `styal/`; a trailing slash is
optional, and an empty prefix adds nothing. Invalid characters in a static prefix
are replaced with hyphens. Custom instructions are appended to
the naming prompt and can specify issue IDs, namespaces, and casing.

These settings apply to automatically named new worktree branches. Select a project
to override its environment defaults. Worktree directories keep their original names.
If generation fails, or a custom name is invalid or already taken, the temporary
branch name remains.

## Scheduled tasks on mobile

Open **Settings → Scheduled tasks** to create scheduled tasks or manage existing
ones across your connected environments. Use the settings filter to narrow the
list by environment or project. Each task runs on the environment you choose,
using its project, model, and workspace settings. Fixed-time schedules use that
environment's time zone, which may differ from your phone's. Choose **Once**
to run a task a single time at a date and time in your own time zone. If the
environment is offline then, the task runs when it is back.

Under **Destination**, choose where runs go. **New thread each run** keeps every
run separate. The two one-thread choices start a thread on the first run and post
later runs there: one continues the same conversation, the other starts each run
in a fresh session that doesn't see earlier runs, so the thread stays readable
without the agent's context growing. To move a one-thread task, pick another
thread in its project under **Destination**. Moving such a task to another
project starts a new thread there on its next run.

Deleting a thread also deletes tasks that post into that thread. Tasks that start
a new thread on each run survive deletion of their previous threads.

You can edit, pause, resume, run immediately, or delete a task from the list.
Webhook tasks only run when their URL is called, so they can't be run
immediately.
Leaving an edited form asks before discarding unsaved changes.

## Webhook automations

In **Settings → Scheduled tasks**, choose **On webhook**
as a task's schedule to run it whenever another service calls its URL, such as
GitHub on a new pull request or a CI job that failed. A public URL needs a
[T3 Connect](remote-access.md) managed tunnel; after you save the task, copy
its URL from the editor. Without one, the editor shows only the URL's path.
**Rotate** replaces the URL and the old one stops working.

The prompt decides what the agent sees. Placeholders pull values out of the
request: `{{body.path}}` for a JSON or form field, `{{headers.name}}`,
`{{query.name}}`, `{{body}}` for the raw body, and `{{request}}` for everything.
For example, `Review this PR: {{body.pull_request.html_url}}` sends only the
pull request link. A placeholder with no value is left empty.

Each value reaches the agent wrapped in `<webhook-data-…>` tags and marked as
untrusted request data. This helps the agent tell it apart from your
instructions, but it doesn't guarantee the agent ignores what the text says.
Inside a value, every `$`, other currency sign and `@`, and a `/` that starts
a lone word, gets an invisible character after it, so mentions like `$skill`,
`@file` and `/command` don't act. Text copied from a value, such as an email
address or a command, carries that character too. Without a signature, anyone
with the URL can start a run with any content. A signature only proves which
service sent the request: a GitHub payload still carries text written by any
GitHub user.

For GitHub, turn on **Require signature**, keep the header
`x-hub-signature-256`, hex encoding and the `sha256=` prefix, and enter the
same secret in the repository's webhook settings with content type
`application/json`. Requests without a valid signature are rejected. Set this
up on desktop or web; mobile keeps an existing signature check but can't turn
one on.

To run only for some requests, add **Filters**. Each one tests a value named
like a placeholder, without the braces, such as `headers.x-github-event` equals
`pull_request` or `body.action` is one of `opened, reopened`. A task runs only
when every filter matches; other requests are answered normally, logged as
**Filtered** with the first filter that failed, and start nothing. Values
compare as text, and a value that is an object or a list only passes
**exists**. Separate **is one of** values with commas; a value can't contain
a comma or start or end with a space.

To suppress repeated deliveries, set a **Duplicate request key** template, such as
`{{headers.delivery-id}}`. The same key is ignored for seven days per task.
To combine a burst, set a **Coalesce key**, such as `{{body.id}}`, and a window
of 10–3600 seconds (120 by default). One run uses the latest body, headers,
and query when the window from the first delivery closes; later requests
do not extend it. Pending windows survive a server restart. Keys must contain
request placeholders; if any placeholder is missing, or the render is empty,
that key's rule is skipped. Clear the templates to turn dedupe off.

Duplicate and coalesced log entries share a limit of 10 per task per minute.
Additional deliveries are accepted without a log entry, and coalesced deliveries
always replace the persisted payload. Coalesced updates count toward a separate
60-per-minute validation limit; exceeding it receives HTTP 429.

On desktop and web, pick **Deliveries** from a task's menu to see recent
requests and the prompt each one produced.

If the environment is offline, the sender gets an error and nothing runs;
redeliver from the sender, such as GitHub's **Recent Deliveries**, once it is
back. To have T3 Connect keep requests instead, turn on **Hold webhooks while
offline** in **Settings → Sharing & access**. T3 Connect then stores requests to a
T3 Connect URL for up to 24 hours and delivers them when the environment
returns. Leave it off if you don't want request bodies stored outside your
machine. To skip requests that waited too long, set **Skip requests older
than** on the task.

## Defaults and inheritance

Threads contains the model and workspace for new threads. Browser and Devices control browser and
device access separately for each environment; Browser's preferences apply to this client. Source control
contains automatic pull, the default pull request merge method and text generation. Threads and
Source control edit environment defaults or project overrides depending on the project crumb.

To override browser or device access for a project, select it in **Settings → Projects** and use
**Agent access**; its simulator memory mode is under **Devices**. Reset an override to follow the environment again. Existing overrides keep their values.

The Projects category, under Code, holds the project's name, icon, additional instructions,
actions, checkouts and removal. **Add to another machine**, under Checkouts, clones the project
onto a connected machine that does not have it yet and copies the `.env` files you choose. Actions
belong to a project: editing them creates the project's own list on each selected environment, and
reset returns to the environment's shared list. A project's `t3.json` actions can be reviewed and
imported there.

Settings a repository can also declare in its project file, such as the workspace for new threads,
resolve in one order: a project override, then the environment setting, then the project file, then
the built-in default. Leave a setting on **Inherit** to let the next tier decide.

The project file is `styal.json` at the repository root. A repository that still has only a
`t3.json` from T3 Code keeps working: its settings and icon apply until it gains a `styal.json`,
after which `t3.json` is ignored entirely, even if `styal.json` cannot be read.

```json
{
  "$schema": "https://styal.build/schema/styal.json",
  "iconPath": "assets/logo.svg",
  "defaultThreadEnvMode": "worktree",
  "worktreeSubmodules": "top-level"
}
```

The `$schema` entry is optional, but enables validation and suggestions in editors that support
JSON Schema. styal also accepts comments and trailing commas in this file. It keeps reading valid
settings when another value fails validation, and **Settings** → **Projects** shows a warning when
any part of the file is ignored.
Browser access changes apply when an agent session next starts.

New worktrees initialize git submodules recursively. If that step is slow because the repository
declares many nested submodules, set **Submodules** in **Settings → Worktrees** under Advanced (with the project
selected to override it there) to **Top level only** to stop at the ones the repository declares
itself, or **Skip** to leave them for a setup script. It resolves in the same order as the
workspace default: a `"worktreeSubmodules"` value in the project file of the branch being checked
out applies when the project and environment are both on **Inherit**.

## Worktree location

New worktrees go in the `worktrees` folder of the T3 home directory. To put them somewhere else,
such as another drive, set **Settings → Worktrees → Worktree location** to an absolute path like
`D:\worktrees` or `~/worktrees`. The setting is per machine. Existing worktrees stay where they
are, and cleanup covers both the default folder and the custom one.

## Fast worktree checkout on macOS

Fast worktree checkout is a beta. Turn it on for each Mac in **Settings → Labs → Fast worktree
checkout**. styal then keeps a few recent checkouts of each repository in the `caches` folder of
the styal home directory. A new worktree is cloned from one of them with APFS copy-on-write, which is
about twice as fast as writing every file and makes the first `git status` in it fast as well.
Turning it off deletes the cache.

The first worktree of a repository uses Git's normal checkout and fills the cache. It needs Git 2.42
or newer. Git's normal checkout is also used for worktrees on a different drive from the styal
home directory, sparse checkouts, repositories whose attributes use filters such as Git LFS, and
repositories whose checkout settings changed.

## Storage cleanup

Open **Settings → Worktrees → Cleanup** to enable automatic cleanup on one machine or all connected
environments. Policies are off by default and run on the server at startup, when changed, and
hourly. Offline machines keep their existing policies.

Select a project to set **Automatic worktree cleanup** to **Inherit**, **Off**, or **Custom**.
Inherit follows each machine's rules; Off keeps that project's worktrees until you remove them
manually. Custom applies separate worktree rules to the selected project or checkout. Browser
captures and log retention remain machine-wide.

Worktrees can be removed after a chosen number of inactive days, after a thread settles, after
merging, or when they have no commits beyond the default branch. Set settled retention to 0 days
to remove a worktree at the next cleanup after settlement. In repositories without remotes,
unchanged-worktree cleanup compares against the branch checked out in the project workspace;
if that checkout has a detached HEAD, the worktree is kept. Only styal-managed worktrees are eligible.
Active sessions and shared worktrees prevent removal. **Keep worktrees with local changes** defaults
to **Uncommitted changes**, which protects tracked edits and untracked files but deletes ignored
files such as `.env` and build output. **Any local files** also protects ignored files other than
`node_modules`. **Edited tracked files** protects only tracked edits and allows untracked and
ignored files to be deleted. Branches and thread history stay; starting another turn recreates the checkout.
Merge cleanup requires a merged pull request whose commits are included in the remote default
branch. A squash or rebase merge on GitHub also counts when the pull request targeted the default
branch and the worktree is still at the pull request's last commit.

Enable **Delete worktrees with deleted threads** to remove safe worktrees after their last
thread is deleted, including archived threads and worktrees left by earlier deletions. The
server waits for sessions and terminals to stop and retries skipped worktrees after restart.
Existing prompts for deleting a worktree manually remain available when this policy is off.

Choose **Delete now** to run the enabled rules immediately. The latest results show which
worktrees were removed or kept and why, plus any failures.
Results also list folders in the worktree folder that no thread uses, with their sizes; cleanup never removes them, so remove them manually if you want.

Browser captures and rotated logs have separate retention periods. Expired capture links stop
working. Current logs, message attachments, and browser profiles are kept.

## Project icons

Select the project and open Project to choose an icon, emoji, monogram, or image. The choice applies to
every checkout in the project group and appears on connected clients. Choose **Automatic** to let
T3 Code detect an icon again.

Choose **Monogram** in the icon picker to set one or two letters or numbers and a color.

When no image is found, web and desktop show a two-character monogram with a color
from the icon palette, derived from the saved project name. For example, `Nebula` becomes `NA`,
`Silver Orchard` becomes `SO`, and `M7 Forge` becomes `M7`.

## Give agents project instructions

Use **Additional instructions** to provide guidance whenever T3 Code starts an agent session for
the project. The instructions apply to every checkout in the project group and work with Codex,
Claude, Cursor, Grok, and OpenCode. Clear the field or reset it to stop including them in future
sessions.

## Name a project coordinator

Turn on **Project coordinators** in **Settings → Labs** to let one thread coordinate a project.
Choose it from **Coordinator** in the project's settings, or with **Make project coordinator** in
the thread's menu on web, desktop or mobile. **Stop being coordinator** or **None** clears it.

With every session, the coordinator gets instructions to hand changes to other threads instead of
making them itself, unless you ask it to. Claude, Codex, Cursor, Grok and OpenCode receive them, as
they do the project's Additional instructions. Threads started in
the project on the same machine report to it, including threads you start: it hears when one fails,
stays stuck on an approval or question, or finishes its first turn with nothing else pending. A
thread the coordinator launched with reports on reports once, and threads you keep talking to stay
yours after their first turn. A turn started by another thread's report doesn't report to the
coordinator, so threads can't keep waking each other. The coordinator must be a thread in the
project. Clearing the coordinator, or turning the Labs switch off, stops new reports. The
coordinator is kept on each machine, not in `styal.json`, and agents cannot set it yet.

With the switch on, each project has a page with its coordinator as the project's chat. Open it with
**Open project** in the command palette, the project's name in a thread's header, the name on a
project's folder, or, in the flat list, the chat's own row. Each shows how many of the project's
threads are working or need you; in folders the chat has no row of its own, and the folder's
chevron still opens and closes it. **Project settings** links open the page, and its gear
button opens the settings. The coordinator's own links (from search, the palette, another thread,
or **Make project coordinator** on the thread you have open) open the page too; **Open as thread**
in the page's header shows it as a thread, with its title, thread menu and details panel. A
project without a coordinator shows an empty chat: the first message starts a thread in the
project's folder, without a worktree, and makes it the coordinator. When the project is on more
than one machine, choose the machine under the composer before sending; it starts on the machine
where the project was last active. The chat stays on that machine, and only threads on it report
to the chat. A machine with project coordinators off is named there instead of offered. **Add to
another machine** in the same menu offers connected machines with project coordinators on that do
not have the project yet; the chat waits there while the project clones, then starts on that
machine.

On mobile, a project with a chat shows it as the project's row in the thread list: the project's
name and how many of its threads are working or need you. With **Group threads by project** on,
tap the project's header instead; the chat has no row of its own there. The chat opens with the
project's name as its title, how many threads are working, and its machine. **New thread** starts
a thread in the project, and the menu holds **Project settings**, the files and the terminal. A
notification about the chat, and a `styal://projects/<environment>/<project>` link, open it too.
Starting a project's first chat still happens on web or desktop.

**Needs you** above the page's composer lists what the project's threads are waiting on: approvals,
questions and report questions, oldest first, each with its thread's name. Click one to answer it
there; the answer goes to the thread that asked, not to the chat. A thread waiting on something the
page can't answer, such as a subagent's request, offers **Open thread**.

Threads the chat launches to report back to it stay off the sidebar while they work or after
they finish; the chat lists the ones still working or waiting on you right after the reply that
started them, and the page's status line counts them. A thread comes back to the sidebar when it
needs an approval or an answer, fails, or when you open it, pin it or send it a message
yourself. They finish without a Done notification, and stay in search and the command palette.
A thread a scheduled task runs in leaves the sidebar too, and its runs finish without a Done
notification. It comes back the same way, except that only a message you sent after the task's
latest run started counts, and it leaves again at the next run. A paused task, or a one-time task
that has run, leaves its thread in the sidebar. **Scheduled** in the page's header lists each task
with its schedule and how its latest run went.

When you open the page after at least half an hour away, the end of the chat lists what happened
since you last looked at it on any of your devices: threads that failed or hit a usage limit, the
chat's reports, threads that finished and you haven't opened, and pull requests that merged. "Last
looked" is when you last opened the page, or the chat's last change while you had it open. Open
questions stay in **Needs you**. Long lists fold into groups with **Show all**. If the chat's earlier
history isn't loaded, **Load earlier** fetches it so older reports can be listed, and the list says
when threads that settled long ago weren't checked. Each thread counts only its latest turn. The list
is not saved: it stays until you leave the page, and next time shows only what came after.

The project's settings name the coordinator under **Coordinator**, its menu offers **Stop being
coordinator**, and the details of a thread that reports to it show **Reports to** with its title.

## Keep the default branch current

In Source control, enable **Automatically pull** to keep the default-branch checkout up to date
with its configured upstream. Choose an environment to set the default or a project to override it.
On mobile, use **Settings → Source control** to change selected environment defaults or project overrides.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.

## Stable workspace ports

Every workspace receives a persistent range of ten development ports; there is no setting to
enable. Agents, terminals, and project scripts launched locally for the workspace receive the first
port as `STYAL_WORKSPACE_PORT`, and the range continues with the next nine numbers. A worktree
keeps its range across restarts, and local threads share the range of the project's main checkout.
Deleting a worktree from styal frees its range. When all ranges are taken, styal first frees the
ranges of deleted workspace directories, then those of the least recently used workspaces whose
threads are all settled or archived, skipping any with an open terminal or a program listening on
their ports. A workspace that loses its range gets a new one, possibly different, the next time it
needs one. If no range is free, threads, terminals, and scripts still start without
`STYAL_WORKSPACE_PORT`, and a new worktree thread's work log says so.

For example, a project script can run `npm run dev -- --port "$STYAL_WORKSPACE_PORT"` and give a
second service `$((STYAL_WORKSPACE_PORT + 1))`. Workspaces in the same environment never receive
overlapping ranges, but unrelated programs on the machine can still listen on those ports.

See [Project scripts](./project-scripts.md) for the script format and other project environment
variables.

## Regenerable files in worktrees

Declare paths your setup action or build recreates in `styal.json`, for example `"regenerableFiles": ["**/node_modules", "apps/*/dist"]`. Patterns are relative to the worktree root; `*` matches within one path segment and `**` matches whole segments. A trailing `/` matches folders only; without it, files and folders match. Only git-ignored paths qualify. Patterns do not search inside an ignored folder unless a pattern matches that folder itself, so `**/node_modules` leaves `.scratch/experiment/node_modules` and `.styal/experiment/node_modules` alone. Never list notes, local state, secrets, or other files you cannot recreate.

`worktreeCleanup` remains a deprecated alias for `regenerableFiles`, so existing files keep working. If both are present, `regenerableFiles` wins and styal reports that the old field is ignored. This project-file list is separate from the age-based worktree retention policy in Settings → Storage.

Patterns take effect once they reach the default branch of the project’s remote: pushed and, where the repository requires it, reviewed. styal reads the last fetched `origin` default-branch version of the project’s own `styal.json`, including for projects in a repository subfolder. With a remote, unpushed local commits do not apply; uncommitted edits never apply. With a remote but no known `origin` default branch, cleanup is skipped; a repository with no remotes uses `init.defaultBranch`, or the registered checkout’s current branch when no default is configured. If that branch cannot be identified or read, cleanup is skipped. Propose pattern changes in a pull request rather than committing them directly to the default branch. styal trusts the configured `origin` and its local `origin/HEAD` pointer; changing that pointer can change which branch supplies patterns, and `origin` may belong to a third party. Withdrawn patterns stop applying after the next fetch.

In the project’s **Settings → Worktrees**, **Clean up regenerable files** controls cleanup on this machine; patterns remain visible read-only when it is off. New projects start with cleanup on. On upgrade, an existing project with declared patterns starts on only if this machine approved every currently declared pattern. Partial approvals, approvals for removed patterns, and unreadable patterns start off. An explicit switch choice is preserved. This migration runs once, before cleanup, and discards the old approval entries.

On macOS and Linux, the hourly storage sweep deletes qualifying paths from settled managed worktrees at least 24 hours after the last thread activity, settlement or archival in the worktree, with no open terminal or live provider session. Tracked files, unignored files, nested repositories, mount points, and selected paths that are symbolic links keep their enclosing match intact. Links inside a selected folder are removed without following them. An inspection that runs out of time or reaches its entry limit leaves the whole worktree for a later sweep; unverifiable folders are kept. **Settings → Storage** reports deleted paths and failures.

The next turn reruns the setup action using its normal approval rules. Synchronous setup finishes before the turn starts; asynchronous setup runs in the background. If setup is interrupted or the server stops before it finishes, the next turn tries again; a finished setup is not automatically repeated, even if it failed. Opening a terminal does not rerun setup yet; use the setup action yourself if you need it before sending a message. Windows does not delete regenerable files, so the switch is unavailable on a Windows machine.

### Free source files in settled worktrees

In the project’s **Settings → Worktrees**, **Free source files in settled worktrees** is off by default and applies only on this machine. **See how it works** under the switch shows a short walkthrough; it also opens once on this device the first time you turn the switch on. When enabled, a storage sweep un-checks-out unchanged tracked files after every thread using the worktree has been settled or archived for seven days. A delegated child without its own settlement or archival follows its parent chain. Files at the repository root, local changes, untracked files and ignored files stay in place, including nested `.env` links, hooks and build folders. Worktrees with unstaged deletions are kept fully checked out because Git could otherwise recreate the deleted files. Windows does not un-check-out source files, so the switch is unavailable on a Windows machine.

Sources are checked out again before a turn, terminal (including setup and project actions), checkpoint rollback or Git action that uses the tree. Stripped regenerable files still follow the setup rules above. A failed restore blocks the operation and reports a failure instead of starting it in an incomplete checkout. Recovery keeps edits made after an interruption. If a local file blocks a source folder, move the named file aside and retry. If a tracked file was deleted, stage or undo the deletion before retrying; interrupted recovery also requires missing protected files to be restored, unless their deletion was staged. Use a shell outside styal for these repairs when its terminal is blocked by recovery.

The first time a worktree is un-checked-out, Git turns on `extensions.worktreeConfig` in the repository’s shared configuration (`.git/config`), and nothing turns it off again. Git then stores sparse-checkout configuration separately for each worktree. Git older than 2.20 refuses to open a repository with this setting. Existing user sparse-checkouts, populated submodules, Git LFS, locked worktrees and unfinished Git operations are kept and reported. Storage lists un-checked-out worktrees and estimated space released, using the allocated blocks of single-link regular files removed. Shared hardlinks and symbolic links are excluded; snapshots and shared filesystem blocks can make actual free-space gains smaller.
