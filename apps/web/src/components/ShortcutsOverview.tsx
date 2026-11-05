import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { useRef } from "react";
import { create } from "zustand";

import { isElectron } from "../env";
import { useClientSettings } from "../hooks/useSettings";
import { reportForkClientUsage } from "../forkClientUsage";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { primaryServerKeybindingsAtom } from "../state/server";
import { buildShortcutsOverview } from "./ShortcutsOverview.logic";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Kbd } from "./ui/kbd";

export const useShortcutsOverviewStore = create(() => ({ open: false }));

const close = () => useShortcutsOverviewStore.setState({ open: false });

export function openShortcutsOverview(
  entryPoint: "shortcut" | "command_palette" | "help_menu",
): void {
  useShortcutsOverviewStore.setState({ open: true });
  void reportForkClientUsage(appAtomRegistry.get(primaryEnvironmentIdAtom), {
    feature: "shortcuts-overview",
    action: "opened",
    entryPoint,
  });
}

export function toggleShortcutsOverview(): void {
  if (useShortcutsOverviewStore.getState().open) close();
  else openShortcutsOverview("shortcut");
}

function ShortcutsOverviewGroups() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const sendShortcut = useClientSettings((settings) => settings.sendShortcut);
  const groups = buildShortcutsOverview(keybindings, {
    platform: navigator.platform,
    isDesktop: isElectron,
    sendShortcut,
  });
  return (
    <div className="gap-8 sm:columns-2">
      {groups.map((group) => (
        <section key={group.id} className="mb-6 break-inside-avoid last:mb-0">
          <h3 className="mb-2 font-medium text-sm">{group.title}</h3>
          <ul className="space-y-1.5">
            {group.entries.map((entry) => (
              <li
                key={entry.command}
                className="flex items-baseline justify-between gap-3 text-muted-foreground text-sm"
              >
                <span className="min-w-0">{entry.label}</span>
                <span className="flex shrink-0 flex-wrap justify-end gap-1">
                  {entry.shortcuts.map((shortcut) => (
                    <Kbd key={shortcut}>{shortcut}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function ShortcutsOverview() {
  const open = useShortcutsOverviewStore((state) => state.open);
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      {/* The dialog opens from the keyboard, where focusing the link would draw its focus ring. */}
      <DialogPopup className="max-w-4xl" initialFocus={popupRef} ref={popupRef}>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Change them in{" "}
            <Link className="underline" onClick={close} to="/settings/keybindings">
              Settings → Keybindings
            </Link>
            .
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ShortcutsOverviewGroups />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
