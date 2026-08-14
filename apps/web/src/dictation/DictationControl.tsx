// Mic button and live-transcription bubble for the composer footer.
//
// Volatile text renders only in the bubble and never touches the draft store —
// drafts persist to localStorage and revision-sync across devices, so streaming
// partials into them would spam sync and pollute undo (.plans/dictation.md).
// Finalized text is inserted once per utterance by useDictation.
//
// Substitutions the matcher made are listed beneath the bubble with one-tap
// revert. That affordance is load-bearing, not polish: phrase collisions like
// "the room is empty" -> isEmpty are deterministic consequences of correct
// transcription and cannot be detected from text (spike findings 15, 16).

import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircleIcon, MicIcon, SquareIcon } from "lucide-react";

import { useComposerHandleContext } from "../composerHandleContext";
import { useClientSettings } from "../hooks/useSettings";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { onToggleDictation } from "./dictationBus";
import { useDictation, type DictationInsertion } from "./useDictation";

export const DictationControl = memo(function DictationControl() {
  const enabled = useClientSettings((settings) => settings.dictationEnabled);
  const { state, liveText, lastInsertion, levelDbfs, noSignal, toggle, cancel } = useDictation();
  const anchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    return onToggleDictation(toggle);
  }, [enabled, toggle]);

  // Escape discards the utterance without inserting — distinct from stop,
  // which transcribes and inserts. Capture phase so open menus don't eat it.
  const active = state !== "idle";
  useEffect(() => {
    if (!active) {
      return;
    }
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [active, cancel]);

  if (!enabled) {
    return null;
  }

  const label = active ? "Stop dictation" : "Start dictation";

  return (
    <div className="relative shrink-0" ref={anchorRef}>
      {active ? (
        <DictationOverlay anchorRef={anchorRef}>
          <div className="mb-1 flex items-center gap-1.5 text-secondary-label">
            <span
              className={
                state === "finalizing"
                  ? "size-1.5 rounded-full bg-secondary-label"
                  : "size-1.5 animate-pulse rounded-full bg-red-500"
              }
            />
            {state === "finalizing" ? "Finishing…" : "Listening"}
          </div>
          {state !== "finalizing" ? (
            <div
              className="mb-1 h-1 overflow-hidden rounded-full bg-separator"
              title={levelDbfs === null ? "no signal yet" : `${levelDbfs.toFixed(0)} dBFS`}
            >
              <div
                className="h-full bg-green-500 transition-[width] duration-75"
                style={{
                  // -60 dBFS..0 dBFS mapped to 0..100%. A meter that never moves
                  // while speaking is the visible symptom of silent capture.
                  width: `${levelDbfs === null ? 0 : Math.max(0, Math.min(100, ((levelDbfs + 60) / 60) * 100))}%`,
                }}
              />
            </div>
          ) : null}
          {noSignal && state === "listening" ? (
            <div className="mb-1 text-amber-500">
              No audio detected — check your microphone and input device.
            </div>
          ) : null}
          <div className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words">
            {liveText === null || (liveText.committed === "" && liveText.tentative === "") ? (
              <span className="text-secondary-label">Speak now…</span>
            ) : (
              <>
                {liveText.committed}
                <span className="text-secondary-label">{liveText.tentative}</span>
              </>
            )}
          </div>
        </DictationOverlay>
      ) : lastInsertion !== null && lastInsertion.substitutions.length > 0 ? (
        <DictationSubstitutionsChip insertion={lastInsertion} anchorRef={anchorRef} />
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={label}
              aria-pressed={active}
              data-dictation-state={state}
              className="shrink-0 px-2"
              onClick={toggle}
            >
              {state === "finalizing" ? (
                <LoaderCircleIcon className="size-4 animate-spin" />
              ) : active ? (
                <SquareIcon className="size-4 text-red-500" />
              ) : (
                <MicIcon className="size-4" />
              )}
            </Button>
          }
        />
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
    </div>
  );
});

const DictationSubstitutionsChip = memo(function DictationSubstitutionsChip(props: {
  insertion: DictationInsertion;
  anchorRef: React.RefObject<HTMLDivElement | null>;
}) {
  const composerHandle = useComposerHandleContext();

  return (
    <DictationOverlay anchorRef={props.anchorRef}>
      <div className="mb-1 text-secondary-label">Dictation replaced:</div>
      <ul className="flex flex-col gap-0.5">
        {props.insertion.substitutions.map((substitution, index) => (
          <li key={index} className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate">
              <span className="text-secondary-label line-through">{substitution.before}</span>{" "}
              <span className="font-mono">{substitution.after}</span>
            </span>
            <button
              type="button"
              className="shrink-0 text-secondary-label hover:text-label"
              onClick={() => {
                // Conservative revert: only when the substituted identifier is
                // still present verbatim; a hand-edited draft is left alone.
                const handle = composerHandle?.current;
                if (handle === null || handle === undefined) {
                  return;
                }
                const snapshot = handle.readSnapshot();
                const index = snapshot.value.lastIndexOf(substitution.after);
                if (index < 0) {
                  return;
                }
                handle.replaceRange(
                  index,
                  index + substitution.after.length,
                  substitution.before,
                );
              }}
            >
              Revert
            </button>
          </li>
        ))}
      </ul>
    </DictationOverlay>
  );
});

/**
 * Fixed-position panel above the mic button, portalled to the body: the footer
 * cluster the button lives in is an overflow-x-auto scroll container, which
 * clips absolutely-positioned children — a bubble rendered there is invisible.
 */
function DictationOverlay(props: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null);

  useEffect(() => {
    const measure = () => {
      const rect = props.anchorRef.current?.getBoundingClientRect();
      if (rect === undefined) {
        return;
      }
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 296)),
        bottom: window.innerHeight - rect.top + 8,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [props.anchorRef]);

  if (position === null) {
    return null;
  }
  return createPortal(
    <div
      className="fixed z-50 w-72 max-w-[70vw] rounded-md border border-separator bg-background p-2 text-xs shadow-md"
      style={{ left: position.left, bottom: position.bottom }}
    >
      {props.children}
    </div>,
    document.body,
  );
}
