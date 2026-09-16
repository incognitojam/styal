# Reading the chat timeline

T3 Code shows tool activity alongside messages so you can follow what the agent is doing. File
edits include the affected path and line-change counts when the provider reports them.

Paths inside the active project or worktree are shown relative to that workspace. The generated
worktree directory is omitted because the thread already provides that context.

![An edited-file activity with a workspace-relative path](./images/edited-file-path-after.png)

Source paths written in messages may become clickable file chips. Opening a chip uses its full
resolved path, while its label and **Copy relative path** action stay workspace-relative.
Click or tap the linked text or file chip to open the file.

When previewing a Markdown file, relative images resolve from that file's folder. Images retain
their authored dimensions and SVG fragment, and copying a workspace image preserves its Markdown
reference.

On web and desktop, select an image in an agent message to expand it. Images that link somewhere
keep their link action.

When a turn finishes on web and desktop, its final assistant response stays visible. Open **Worked
for** to read earlier responses and tool activity from that turn.

Codex file citations appear as file chips on web, desktop, and mobile. A reusable template created
by Codex appears as a card with its name and type. Select **Use template** to add an editable prompt
to the composer. Review or change the prompt, then send it when you are ready.
