# Welcome page

styal shows a Welcome page when you open a new installation. Existing
workspaces skip it. It shows what styal found on the computer you are using,
on one page: your agents, projects from your Claude Code, Codex, and Pi history,
your T3 Code install, how finished threads settle, and the phone app. Only an
agent is needed to start chatting.

To see the page again, go to **Settings → About → Welcome page** and select
**Open**. Direct links, such as Settings, open normally before setup is done.

The hosted app at app.styal.build opens the page on first use when no computer
is connected yet. Choose computers in **Computers** first. Computers that already
have projects or threads are left out of setup, and when all of them have work,
**Start** opens the app. Opening the page from Settings sets up every computer you
select.

If styal cannot confirm the workspace during startup, it shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If styal cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Computers

With more than one computer available, or on the hosted app, the page starts
with **Computers**. The computer you opened styal on is selected; check others to
set them up too, and the rest of the page then covers each of them. Unchecking a
computer leaves it out of setup without disconnecting it.

- Computers you have saved are listed with their connection. One that runs a
  styal version this app cannot talk to cannot be selected; the line under its
  name says which side to update.
- **Computers linked to your styal Link account** lists the computers signed in
  to your account after you sign in. A listed computer connects only when you
  check it. To link another computer, run `styal link` on it and keep styal
  running there.
- **Add a computer with a pairing link** connects to a server on your network or
  tailnet. Run `styal pair` (or `styal pair --tailscale`) on that computer and
  paste the link.

A selected computer that is not connected is left out, and the page names it.

## Agents

styal lists the agents it found on the computer first, ready ones on top.
**Add more agents** lists every other agent styal supports, A to Z. When no agent
is found, it reads **Set up an agent** and opens by itself:

- **Turn on** enables an agent that is off on this computer, including one only
  some projects use. styal then checks whether it is installed and signed in.
- For Claude Code, **Install** or **Sign in** opens a terminal with the correct
  command ready to run. Install uses the vendor's own installer, which keeps
  **Update now** working in Settings.
- For Codex, **Set up** offers sign-in with your ChatGPT account or your own
  Codex CLI. **Use existing CLI** opens the terminal to install or sign in, and
  **Continue with ChatGPT** stays available until Codex is signed in.
- When styal knows an installed version does not work with it, **Update** opens
  the agent in **Settings → Providers**, which shows the version to use and updates it
  when it can.
- Other agents, and agents that could not load, open their page in
  **Settings → Providers**.
- **Browse** opens the ACP Registry for more agents.

On the desktop app, when the folder of the `styal` command is not on your `PATH`,
**Add to PATH** adds one line to your shell's startup file.

The setup terminal uses the home directory and environment configured for the
provider instance. Sensitive values remain redacted in Settings and
terminal metadata while the terminal process can use them.

With several computers, each has its own **Agents** band. Closing a setup
terminal, opening another agent's terminal, unchecking its computer, leaving the
page, or selecting **Start** asks first while the command in it is still running.

**Start** waits for one ready agent on any computer being set up. Select **Start
without an agent** to finish without one. Checked projects are still imported.

## Phone

Select **Set up**. On Android, scan the code, or select **Open Android
releases**, to get the newest **styal for Android** release and install its APK;
see [Mobile app](./install.md#mobile-app). On iPhone and iPad, styal is on
TestFlight, which is invite-only. Then select **Sign in to styal Link** and allow
this computer when styal asks, so the app can reach it. Sign in to the app with
the same account. If you are signed in but this computer is not shared yet, select
**Set up styal Link**. If styal Link is on but the app cannot reach this computer,
select **Check styal Link** to see why. The page leaves the phone out on builds
without styal Link, when the computer you opened styal on is not being set up, or
when your organization turns it off. You can still pair the app with a code from
**Settings → Sharing & access**.

## Projects

styal finds directories that Claude Code, Codex or Pi has used. Git repositories
are listed first, newest activity on top. When the remote is on GitHub, the
group shows the repository as `owner/name`. Clones with the same remote share
one group. Directories that are not git repositories sit under "Other folders".

The page offers git repositories active within the last 30 days with at least
three conversations, already checked. Projects already in styal are not checked
again. Uncheck the box to start without them, or
select **Review all** to pick from everything found, with "Select all" and
"Select none". Linked worktrees of bare repositories
can be offered as separate projects. Conversations in other linked git worktrees
count toward their main checkout, so a repository is offered even if you only
worked in its worktrees. Codex scratch directories under `Documents/Codex`, and
anything under `Downloads` are not offered.

A large or malformed history can reach the scan limit. styal keeps the
projects it found and warns when projects or conversations may be missing.

Imported projects include Claude, Codex and Pi conversations active within the last
30 days. You can continue those conversations in styal. Pi is off by default:
open **Add more agents** and select **Turn on** next to Pi, and the page looks for
its sessions too. Pi sessions
are read from each enabled Pi provider's session directory, which follows
`PI_CODING_AGENT_SESSION_DIR` and `PI_CODING_AGENT_DIR` in its environment. A
Pi conversation imports its active branch, the one Pi reopens.

Conversation import is best effort. styal keeps the first user prompt and the
newest remaining visible user and assistant messages, with 200 messages total.
It omits tool activity and attachments. For Codex, it omits generated setup
context only when a canonical user event and a valid shared turn ID identify the
same user turn. Ambiguous legacy or response-only context stays in the imported
conversation so styal does not remove user text. It reads one conversation at
a time and skips files larger than 4 GiB. It also skips a conversation when the
message text and metadata it keeps need more than 32 MiB of memory. Tool output
does not count toward that limit. It skips a conversation with more than 100,000
records every time, so opening the page again does not import it. It ignores
malformed records and skips unreadable or unparseable conversations.

Each import attempt reads up to 100 conversation files and 4 GiB per project. To
continue a large batch, open the Welcome page again and pick the project in
**Review all**. Completed conversations are not imported again. You can continue
without the remaining history.

You can start without importing. While an import runs, styal stays on the
Welcome page and shows each project as queued, importing, complete, or not fully
imported. A project that is not fully imported stays checked, so **Start** tries it
again; uncheck it to continue without it. If you quit, open the Welcome page again
from **Settings → About**; the projects you started stay checked.

## T3 Code

When a computer being set up has a T3 Code install, the page shows **T3 Code**
with two choices: **Import projects from T3 Code** and, when its preferences
differ from styal, **Bring over T3 Code preferences**. Either can be left out
without changing the other. **Review** lists each computer's T3 Code projects and
the preferences that would change, where you can pick projects and keep the
current preferences on any computer. **Start** imports each computer's projects,
then its preferences, before the history import, and waits until each computer
has been checked for T3 Code. If something fails, the page stays and keeps the
failed work selected, so **Start** tries again. The same
import is available later in **Settings → Import data**; see
[Import T3 Code data](./importing-t3-code-data.md).

## Threads

Settling moves a finished thread to the **Settled** shelf at the bottom of the
sidebar without deleting it. **Threads** chooses whether threads settle on their
own when their pull request merges, and after a few days without activity. The
choice starts from the first computer's current settings, and **Start** saves it on
every computer being set up whose settings differ, keeping each computer's own
number of days. If a save fails, the page stays so you can try again. Turn both
off to settle threads only by hand, or change them later in **Settings → Threads**;
see [Settle finished work](./thread-sidebar.md#settle-finished-work).
