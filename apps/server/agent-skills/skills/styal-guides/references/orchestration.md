# Orchestration

Use a delegated task for bounded work that should return to this turn, such as a review or an
implementation step. It reports its result to its parent automatically. Delegated children cannot
watch pull requests.

Use a top-level thread only when the user asks for a new thread. Give it a brief it can start
without this conversation: the goal, decisions, where to look, base branch and what done means.
Mention threads by the `link` returned by the tools. Follow the delegated task's returned `next`
instruction instead of polling it.
