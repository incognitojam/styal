# Welcome wizard

styal shows a setup flow when you open a new installation or connect to the
hosted app for the first time. Existing workspaces skip this flow.

## Connect your computers

Select one or more computers to set up. If you opened styal directly from a
server or the desktop app, that computer is already connected and selected.
It is identified by its name, which may differ from the device running your
browser.

You can add more computers before continuing:

- **styal Link** connects computers that are signed in to your account. Run
  `npx @styal/cli connect` on each computer you want to add, then start styal or run
  `npx @styal/cli serve` so the computer stays available.
- **Add a computer** connects directly to a server on your network or tailnet.
  Start the server with `npx @styal/cli serve`, then run `npx @styal/cli pair --tailscale` and
  paste the pairing link. You can also run `npx @styal/cli serve --host <address>` and
  use `npx @styal/cli pair` when the server is already reachable on your network.

Saved computers and computers discovered through styal Link are selected by
default. Uncheck any you do not want to set up; this does not disconnect them.
Continue when your selected computers are connected. Setup checks
agents across the selected computers, then offers project import grouped by computer.

If styal cannot confirm the workspace during startup, the setup flow shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If styal cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Check your agents

styal checks each selected computer for Claude Code and Codex. If an agent is
not installed or signed in, select its action to open a terminal with the
correct command ready to run. Other providers can be enabled in Settings.
The installers do not require Node or npm. For a standalone Codex installation,
run `codex update` on that computer to update it; one-click updates for this
installation type are not yet available in Settings.

Leaving an active setup terminal asks before stopping its running process.
Idle or exited terminals close immediately.

The setup terminal uses the home directory and environment configured for the
selected provider instance. Sensitive values remain redacted in Settings and
terminal metadata while the terminal process can use them.

## Import your projects

styal finds directories that Claude Code or Codex has used. The default
selection includes projects active within the last 30 days. Use the checkboxes
to include older projects or change the selection.

A large or malformed history can reach the scan limit. styal keeps the
projects it found and warns when projects or conversations may be missing.

Imported projects include Codex and Claude conversations active within the last
30 days. You can continue those conversations in styal.

Conversation import is best effort. styal keeps the first user prompt and the
newest remaining visible user and assistant messages, with 200 messages total.
It omits tool activity and attachments. For Codex, it omits generated setup
context only when a canonical user event and a valid shared turn ID identify the
same user turn. Ambiguous legacy or response-only context stays in the imported
conversation so styal does not remove user text. It reads one conversation at
a time and skips files larger than 16 MiB. It ignores malformed records and skips
unreadable or unparseable conversations.

Each import attempt reads up to 100 conversation files and 64 MiB per project,
with up to 100,000 input records. Run import again to continue a large batch.
Completed conversations are not imported again. You can continue without the
remaining history.

You can continue without configuring agents or importing projects, or return to an earlier step
using the setup progress bar. Navigation pauses while an import is running.
