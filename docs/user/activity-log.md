# Activity log

On web and desktop, consecutive tool calls appear as an expandable summary. Open it to inspect
commands, tool inputs, status, and exit codes. Expand a tool call to see its output. A running
command's output updates live, and long output shows only its most recent part. Use **Open diff** on
a file change to review its contents.

T3 Orchestrator summaries describe the actions taken, such as **Ran 2 commands and sent messages
to 3 threads**. Repeated messages to the same destinations show both counts: **Sent 5 messages to
2 threads**. Thread creation counts the threads returned by the tool, including batches.

Groups with many kinds of activity show up to two specific action categories and a count of the
remaining actions. Commands, file changes, and orchestration changes take priority over reads and
status checks. Expand the group for the full list.

Failed calls do not count as successful messages or creations. Waiting on a thread does not mean
it finished, and an interrupt or cancellation request does not mean the thread stopped. When tool
details are unavailable, summaries use a broader description instead of guessing how many threads
were affected.

## When an agent may be stuck

styal adds a warning to the activity log if startup has not attached a provider turn after five
minutes, or an attached turn has no recorded activity for ten minutes. This appears on web,
desktop, and mobile. Known running tools, child agents, pending questions and approvals, and
provider retry waits suppress the warning. Quiet reasoning can still be healthy; the warning
does not stop or retry the agent.

If the agent appears stuck, stop the turn and send a message to continue in the same thread.
The warning clears when activity resumes, known work or a request appears, or the turn ends.
The activity log retains a record of the incident.
