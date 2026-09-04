# Import T3 Code data

Use **Settings → Import data** on web or desktop to bring projects, threads, and preferences from T3 Code into styal.

## Choose a server

Import runs on the server selected at the top of the page. That server checks its own default T3 Code data in `~/.t3/userdata`, so repeat the import for each server that has an older installation. styal recognizes both regular T3 Code data and T3 Code (yngatech) data in that location.

T3 Code can stay open while you import. styal reads its database without modifying it and takes a consistent snapshot of the selected project history.

## Import projects and threads

The project list separates projects that will transfer into styal from projects that are already there and have missing threads. Transfer rows show how many threads and scripts they include. A project can also appear when an earlier import needs its provider context restored. Select the projects you want, then choose **Import projects**.

The list refreshes while the page is open, so projects added to or removed from the old installation appear automatically.

A new project includes its name, workspace, icon, additional instructions, default model, default thread environment, scripts, and threads. When styal already has the project or workspace, its current project setup stays and the import adds its missing threads.

Each thread is committed with its history and provider continuation as one transaction. Attachments are copied and checked before that transaction is committed. The continuation contains the provider's conversation identifier, not its credentials or active-session state, so the next message can resume with the original context. If an import is interrupted, completed threads stay imported and the next preview omits them; running the import again continues with the remaining threads.

Imports made by an affected earlier styal release can be repaired from the same page. The project row shows how many threads need their context restored, and the import replaces a missing or unrelated continuation with the one still stored by T3 Code. Any loaded session for that thread is stopped first, so its next message uses the restored context.

If the old database refers to an attachment file that is no longer present, styal imports the rest of the thread without the broken attachment and reports how many attachments were skipped.

## Import preferences

The Preferences table compares the current value in styal with the value after import. **Import preferences** applies the values shown in the table to the selected server. It includes:

- background activity policy and refresh intervals;
- host and client idle or power-saving behavior;
- provider update checks and agent browser access;
- defaults for new threads, worktrees, and the add-project directory;
- source-control writing style, custom instructions, and change-request templates; and
- legacy token streaming.

When every value already matches, the import button is disabled.

Connections, provider sign-ins, credentials, tokens, and active sessions stay separate. Client-local choices such as appearance, fonts, and keybindings are not part of the server preference import.
