# Welcome wizard

styal shows a setup flow when you open a new installation or connect to the
hosted app for the first time. Existing workspaces skip this flow. Setup has
**Connect**, **Agents**, and **Projects** steps, plus **Preferences** when a
selected computer has T3 Code preferences that differ from styal.

## Connect your computers

Select one or more computers to set up. If you opened styal directly from a
server or the desktop app, that computer is already connected and selected.
It is identified by its name, which may differ from the device running your
browser.

You can add more computers before continuing:

- **styal Link** connects computers that are signed in to your account. Run
  `npx @styal/cli link` on each computer you want to add, then start styal or run
  `npx @styal/cli serve` so the computer stays available.
- **Add a computer** connects directly to a server on your network or tailnet.
  Start the server with `npx @styal/cli serve`, then run `npx @styal/cli pair --tailscale` and
  paste the pairing link. You can also run `npx @styal/cli serve --host <address>` and
  use `npx @styal/cli pair` when the server is already reachable on your network.

Select the saved or linked computers you want to set up. Signing in to styal Link
shows your computers without adding connections; selecting a new computer connects it.
Unchecking a computer removes it from setup without disconnecting it.
Continue when your selected computers are connected. Setup checks
agents across the selected computers, then offers two import sources.

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

Choose **T3 Code** to migrate an existing installation, or **Claude Code / Codex**
to import CLI conversation history. Setup imports projects from one source at a
time. Each source only checks the computers selected earlier in setup.

When there are preferences to review, **Continue** opens the top-level
**Preferences** step. **Skip projects** also opens Preferences, without selecting
any projects. Otherwise, **Import & finish** imports the project selection and
completes setup; **Skip for now** on the source chooser finishes without importing.
Nothing is imported until the final review. Navigation is disabled while an import runs. T3 Code migration
remains available in **Settings → Import data**; CLI history import is available
only during first setup.

### T3 Code data

Projects and conversations are read from each computer's default T3 home and
imported into styal on that same computer. Completed projects are deselected;
failed projects remain selected for retry.

Selections are retained when you return to Projects or Agents using the setup
progress bar, or change computers. The footer totals your choices across
computers. Settings shows projects and preferences together with a direct
**Import** action.

While importing, the main panel shows remaining threads and repairs, preference
imports, and completed work for each computer. Counts refresh every 30 seconds.

### Claude/Codex history

styal finds directories that Claude Code or Codex has used. The default
selection includes projects active within the last 30 days. Use the checkboxes
to include older projects or change the selection.

A large or malformed history can reach the scan limit. styal keeps the
projects it found and warns when projects or conversations may be missing.

Imported projects include Codex and Claude conversations active within the last
30 days. You can continue those conversations in styal. If the scan fails on a computer
running an older styal version, update that computer and retry.

During import, each selected project shows whether it is queued, importing, complete, or could not be imported. Completed counts come from the import result. Failed projects stay selected so you can retry.

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
Conversations already imported through this CLI history flow are not imported again.
This does not deduplicate against conversations migrated from T3 Code or created
directly in styal. You can continue without the remaining history.

You can continue without configuring agents or importing projects, or return to an earlier step
using the setup progress bar. Navigation pauses while an import is running.

## Review preferences

After selecting computers, styal checks their T3 Code preferences while you review
agents. The **Preferences** step appears only if at least one selected computer
has differing values. It is omitted when there is no T3 Code installation, no
saved preferences, or all values already match.

This step is independent of the project source: you can import preferences after
choosing Claude Code / Codex history, T3 Code projects, or skipping projects.
Differing preferences are selected by default. Review the changed values and clear
**Bring over T3 Code preferences** on any computer where you want to keep the current values.
**Import & finish** imports your selected projects and preferences; **Finish**
completes setup if nothing is selected. Importing projects alone does not replace
preferences.
