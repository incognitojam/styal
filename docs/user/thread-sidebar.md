# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
Pinned threads are shown independently of their project, including when you connect to more than
one environment.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Filtering by project

The menu below the search box narrows the sidebar to a single project. While a project is
selected, **New thread** creates in that project instead of asking which one you want, so you can
pick a project once and keep working in it. Threads you start this way always appear in the list
you are looking at.

The keyboard keeps both doors open. The **new thread in current project** shortcut starts a thread
beside the one you have open, even when the sidebar is narrowed to somewhere else — with nothing
open it uses the filtered project. The plain **new thread** shortcut still opens the project
chooser. Choose **All projects** to clear the filter.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.

## Copying a transcript

To share a conversation or reuse it as context in a new thread, open a thread's context menu and
choose **Copy transcript**. The conversation is copied as markdown: the user and assistant
messages under the thread title, without tool activity or replies that are still streaming. The
transcript is fetched from the server, so it works on threads you have not opened recently.

## Completion sounds

On web and desktop, choose a **Completion sound** in **Settings → General** to hear when an agent
finishes a response or asks for structured input. An input request appears as **Awaiting Input**
until you answer it; it remains separate from the unread completion indicator.
