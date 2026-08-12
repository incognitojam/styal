# Run commands in the terminal

In the web and desktop clients, shell code blocks in completed agent replies include a **Run in
terminal** action alongside the line-wrap and copy actions. Review the command, then select the
terminal action to open the thread's terminal and run it from the thread working directory.

T3 Code reuses the active terminal when it is idle. If that terminal has a running process, it opens
a new terminal so the command does not get typed into the existing process. The action only appears
for recognized shell fences such as `sh`, `bash`, `zsh`, and `powershell`; source-code and plain-text
blocks remain copy-only.

![A shell code block with the Run in terminal action](./images/run-command-code-block-after.png)
