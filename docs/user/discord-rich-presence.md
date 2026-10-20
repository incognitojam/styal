# Discord Rich Presence

In the desktop app, open **Settings → General → Activity sharing** and enable
**Discord Rich Presence**. It is off by default. Discord must be running on the same
computer, with activity sharing enabled in Discord. The setting previews the activity
card with your current counts, or example counts when nothing is active, so you can
check what others will see before enabling it.

Your activity shows **styal**, with a summary such as
**3 active threads across 2 projects**. Active means unsettled, including threads waiting for you;
it does not mean an agent is currently generating a response. Archived and snoozed
threads are excluded, as are subagent threads that agents start, which the sidebar hides. Automatic settlement follows your sidebar preferences.
A **View on GitHub** button links to the public styal repository. The elapsed time counts
from when you opened the desktop app.

The counts cover connected environments, independent of sidebar filters. Multiple
threads in one project count as one project; projects on separate environments count
separately. Disconnected environments do not contribute cached counts.

Only counts are shared, never project names, thread titles, prompts, paths, or model
choices. Activity disappears when there are no active threads, you disable the setting,
or you close the desktop window. If Discord restarts, styal reconnects automatically.

Once enabled, the setting shows whether styal reached Discord and which Discord account
it is sharing as. If it says Discord can't be reached, open the Discord desktop app;
styal keeps trying. If it shows your account but friends can't see the activity, check
**Activity Privacy** in Discord's settings, which styal cannot read.

This setting is available only in the desktop app. It works with remote environments
because the connection to Discord stays on your computer. No Discord login or bot token
is needed in styal.
