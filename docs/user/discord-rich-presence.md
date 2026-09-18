# Discord Rich Presence

In the desktop app, open **Settings → Appearance → Activity sharing** and enable
**Discord Rich Presence**. It is off by default. Discord must be running on the same
computer, with activity sharing enabled in Discord.

Your activity shows **styal**, with a summary such as **3 active threads** and
**Across 2 projects**. Active means unsettled, including threads waiting for you;
it does not mean an agent is currently generating a response. Archived and snoozed
threads are excluded. Automatic settlement follows your sidebar preferences.

The counts cover connected environments, independent of sidebar filters. Multiple
threads in one project count as one project; projects on separate environments count
separately. Disconnected environments do not contribute cached counts.

Only counts are shared, never project names, thread titles, prompts, paths, or model
choices. Activity disappears when there are no active threads, you disable the setting,
or you close the desktop window. If Discord restarts, styal reconnects automatically.

This setting is available only in the desktop app. It works with remote environments
because the connection to Discord stays on your computer. No Discord login or bot token
is needed in styal.
