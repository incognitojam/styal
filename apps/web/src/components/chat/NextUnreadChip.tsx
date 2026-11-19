import { useAtomValue } from "@effect/atom-react";
import { useLayoutEffect } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { SidebarAttentionIcon } from "../sidebar/attentionStatus";
import {
  requestNextUnreadThread,
  useNextUnreadInlineSlots,
  useNextUnreadSummary,
} from "../sidebar/nextUnreadThreadBus";
import { Button, InlineButton } from "../ui/button";
import { Kbd } from "../ui/kbd";

/**
 * Shown above the composer while another thread is waiting for the user. It
 * does what the next unread shortcut does and shows that shortcut. `inline` is the
 * form for a card's header in the composer stack, where it takes the chip's place.
 */
export function NextUnreadChip({ inline = false }: { inline?: boolean }) {
  const summary = useNextUnreadSummary((state) => state.summary);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shownInline = useNextUnreadInlineSlots((state) => state.count > 0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this header slot so the floating chip, rendered elsewhere, steps aside
  useLayoutEffect(() => {
    if (!inline) return;
    useNextUnreadInlineSlots.setState((state) => ({ count: state.count + 1 }));
    return () => useNextUnreadInlineSlots.setState((state) => ({ count: state.count - 1 }));
  }, [inline]);
  if (summary === null || (!inline && shownInline)) return null;
  const shortcut = shortcutLabelForCommand(keybindings, "thread.nextUnread");
  if (inline)
    return (
      <InlineButton
        touchTarget="padded"
        aria-label={`Go to next unread thread, ${summary.count} waiting`}
        title={shortcut ?? undefined}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => requestNextUnreadThread("chip")}
      >
        <span className="flex items-center gap-1 [&_svg]:size-3.5">
          <SidebarAttentionIcon attention={summary.attention} />
          {summary.count} unread
        </span>
      </InlineButton>
    );
  return (
    <Button
      aria-label={`Go to next unread thread, ${summary.count} waiting`}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => requestNextUnreadThread("chip")}
      className="pointer-events-auto"
      size="xs"
      variant="glass"
    >
      {/* The pill's rounded ends crowd the icon and shortcut, so inset them further than the default button padding. */}
      <span className="flex items-center gap-1.5 pl-1 pr-0.5">
        <SidebarAttentionIcon attention={summary.attention} />
        {summary.count} unread
      </span>
      {shortcut ? (
        <span className="mr-0.5 ml-1 max-sm:hidden">
          <Kbd>{shortcut}</Kbd>
        </span>
      ) : null}
    </Button>
  );
}
