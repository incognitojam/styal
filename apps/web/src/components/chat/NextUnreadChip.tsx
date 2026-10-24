import { useAtomValue } from "@effect/atom-react";

import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { SidebarAttentionIcon } from "../sidebar/attentionStatus";
import { requestNextUnreadThread, useNextUnreadSummary } from "../sidebar/nextUnreadThreadBus";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";

/**
 * Shown above the composer while another thread is waiting for the user. It
 * does what the next unread shortcut does and shows that shortcut.
 */
export function NextUnreadChip() {
  const summary = useNextUnreadSummary((state) => state.summary);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  if (summary === null) return null;
  const shortcut = shortcutLabelForCommand(keybindings, "thread.nextUnread");
  return (
    <Button
      aria-label={`Go to next unread thread, ${summary.count} waiting`}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => requestNextUnreadThread("chip")}
      className="pointer-events-auto"
      size="xs"
      variant="glass"
    >
      <SidebarAttentionIcon attention={summary.attention} />
      {summary.count} unread
      {shortcut ? (
        <span className="max-sm:hidden">
          <Kbd>{shortcut}</Kbd>
        </span>
      ) : null}
    </Button>
  );
}
