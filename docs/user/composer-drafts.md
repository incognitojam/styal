# Composer drafts

Draft text in an existing thread follows you between web and desktop clients connected to the same
T3 Code environment. The selected model, runtime mode, and interaction mode travel with the text.
Changes sync after a short typing pause and converge after an offline client reconnects. Mobile
drafts remain device-local and do not participate in this synchronization.

Drafts for a new task remain on the device until the thread is created. Images, terminal excerpts,
preview selections, review comments, and other device-specific context also remain local. While an
existing-thread draft contains any of that context, T3 Code withholds the whole draft from other
devices so they cannot send an incomplete version of it.

Sending clears only the server revision that was visible when Send was pressed. If another device
has already changed the draft, that newer revision is preserved.

Drafts are stored by the T3 Code server for that environment. They are not shared between separate
servers, even if both servers contain a thread with the same name.
