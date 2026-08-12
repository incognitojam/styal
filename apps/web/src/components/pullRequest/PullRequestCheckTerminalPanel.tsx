import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "~/appearanceFonts";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import type { RightPanelSurface } from "~/rightPanelStore";
import { useKnownTerminalSessions } from "~/state/terminalSessions";

import { TerminalViewport } from "../ThreadTerminalDrawer";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

/** A single-purpose terminal hosted by the Pull requests page's synthetic panel owner. */
export function PullRequestCheckTerminalPanel({
  threadRef,
  surface,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  surface: Extract<RightPanelSurface, { kind: "terminal" }>;
  onClose: (terminalId: string) => void;
}) {
  const terminalRef = surface.terminalRef ?? threadRef;
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const sessions = useKnownTerminalSessions({
    environmentId: terminalRef.environmentId,
    threadId: terminalRef.threadId,
  });
  const summary =
    sessions.find((session) => session.target.terminalId === surface.activeTerminalId)?.state
      .summary ?? null;
  if (summary === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Opening check logs…
      </div>
    );
  }

  return (
    <div className="h-full p-1">
      <TerminalViewport
        advancedTypography={advancedTypography}
        threadRef={terminalRef}
        threadId={terminalRef.threadId}
        terminalId={surface.activeTerminalId}
        terminalLabel={summary.label}
        cwd={summary.cwd}
        worktreePath={summary.worktreePath}
        runtimeEnv={{}}
        onSessionExited={() => onClose(surface.activeTerminalId)}
        focusRequestId={0}
        autoFocus
        resizeEpoch={0}
        drawerHeight={0}
        keybindings={EMPTY_KEYBINDINGS}
        {...(surface.presentationsByTerminalId?.[surface.activeTerminalId]
          ? { outputPresentation: surface.presentationsByTerminalId[surface.activeTerminalId] }
          : {})}
      />
    </div>
  );
}
