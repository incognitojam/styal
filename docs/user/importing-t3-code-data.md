# Import T3 Code data

Use **Settings → Import data** on web or desktop, or the Projects step during setup, to bring projects, threads, and preferences from T3 Code into styal. The same screen also offers Claude Code and Codex history; see [Import your projects](welcome-wizard.md#import-your-projects).

## Choose a server

Use the computer selector to review each server. Selections are kept separately, and **Import** runs them across the selected computers. Each server checks its own default T3 Code data in `~/.t3/userdata`.

T3 Code can stay open while you import. styal reads its database without modifying it and takes a consistent snapshot of the selected project history.

## Import projects and threads

The T3 Code list shows thread counts and identifies projects already in styal, along with scripts or repairs when applicable. A project can also appear when an earlier import needs its history or provider context repaired. Select the projects you want, then choose **Import** (or **Import & finish** during setup). Completed projects are deselected; failed projects remain selected for retry.

The list refreshes while the page is open, so projects added to or removed from the old installation appear automatically.

A new project includes its name, workspace, icon, additional instructions, default model, default thread environment, scripts, and threads. When styal already has the project or workspace, its current project setup stays and the import adds its missing threads.

Each thread is committed with its history and provider continuation as one transaction. Attachments are copied and checked before that transaction is committed. The continuation contains the provider's conversation identifier, not its credentials or active-session state, so the next message can resume with the original context. If an import is interrupted, completed threads stay imported and the next preview omits them; running the import again continues with the remaining threads.

Imports made by an affected earlier styal release can be repaired from the same page. The project row shows how many threads need repair. The import can reconnect a user prompt to its original turn from the history still stored by T3 Code, or replace a missing or unrelated provider continuation. A loaded session is stopped only when its continuation changes, so its next message uses the restored context.

If the old database refers to an attachment file that is no longer present, styal imports the rest of the thread without the broken attachment and reports how many attachments were skipped.

## Import preferences

Preferences are unchecked by default. Select **Bring over T3 Code preferences** on each computer where you want them applied. **Review changes** compares the current value with the value after import, showing only differences. Preferences apply to that computer when you choose **Import**, independently of project selection. They include:

- background activity policy and refresh intervals;
- host and client idle or power-saving behavior;
- provider update checks and agent browser access;
- defaults for new threads, worktrees, and the add-project directory;
- source-control writing style, custom instructions, and change-request templates; and
- legacy token streaming.

When every value already matches, the preferences checkbox is disabled.

Connections, provider sign-ins, credentials, tokens, and active sessions stay separate. Client-local choices such as appearance, fonts, and keybindings are not part of the server preference import.

## Older fork installations

Importing data from an older fork still works. If you instead reuse its data directory directly,
first start it with a fixed release from August 9, 2026 or later that includes the legacy database
repair. Installations that have already run a fixed release can upgrade normally.
