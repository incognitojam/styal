// Dictation state for the composer: one utterance at a time, live text while
// speaking, matcher-recovered identifiers on the finalized text, insertion
// through the composer handle with a stash fallback when the composer refuses.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyDictationVocabulary,
  buildDictationVocabulary,
  type DictationSubstitution,
} from "@t3tools/shared/dictationMatcher";

import { randomUUID } from "~/lib/utils";

import { useComposerHandleContext } from "../composerHandleContext";
import { useClientSettings } from "../hooks/useSettings";
import { usePromptStashStore } from "../promptStashStore";
import { toastManager } from "../components/ui/toast";
import { startDictationSession, type DictationSessionHandle } from "./dictationSession";
import { collectDictationVocabulary } from "./dictationVocabulary";

export type DictationState = "idle" | "starting" | "listening" | "finalizing";

export interface DictationLiveText {
  readonly committed: string;
  readonly tentative: string;
}

export interface DictationInsertion {
  readonly text: string;
  readonly substitutions: readonly DictationSubstitution[];
}

export function useDictation(): {
  state: DictationState;
  liveText: DictationLiveText | null;
  /** The most recent insertion, for the substitution-revert affordance. */
  lastInsertion: DictationInsertion | null;
  /** Peak level of the latest capture frame in dBFS, while listening. */
  levelDbfs: number | null;
  /** Listening, but nothing above the silence floor has arrived yet. */
  noSignal: boolean;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  toggle: () => void;
} {
  const [state, setState] = useState<DictationState>("idle");
  const [liveText, setLiveText] = useState<DictationLiveText | null>(null);
  const [levelDbfs, setLevelDbfs] = useState<number | null>(null);
  // True once listening has run for a while with every frame under the silence
  // threshold — the clamshell-mic case, surfaced during capture, not after.
  const [noSignal, setNoSignal] = useState(false);
  const heardSignalRef = useRef(false);
  const [lastInsertion, setLastInsertion] = useState<DictationInsertion | null>(null);
  const sessionRef = useRef<DictationSessionHandle | null>(null);
  const composerHandle = useComposerHandleContext();
  const vocabularyEnabled = useClientSettings((settings) => settings.dictationVocabularyEnabled);
  const stashEntry = usePromptStashStore((store) => store.stashEntry);

  // Refs so the async session callbacks never see stale values.
  const vocabularyEnabledRef = useRef(vocabularyEnabled);
  vocabularyEnabledRef.current = vocabularyEnabled;

  const insertFinalText = useCallback(
    (rawText: string) => {
      const trimmed = rawText.trim();
      if (trimmed.length === 0) {
        return;
      }

      let text = trimmed;
      let substitutions: readonly DictationSubstitution[] = [];
      if (vocabularyEnabledRef.current) {
        const vocabulary = buildDictationVocabulary(collectDictationVocabulary());
        const matched = applyDictationVocabulary(trimmed, vocabulary);
        text = matched.text;
        substitutions = matched.substitutions;
      }

      const inserted =
        composerHandle?.current?.insertTextAtEnd(text, { ensureLeadingBoundary: true }) ?? false;
      if (inserted) {
        setLastInsertion({ text, substitutions });
        return;
      }

      // The composer refuses inserts while connecting, in approval state, or
      // with pending inputs. Losing dictated speech is worse than a detour, so
      // park the utterance in the prompt stash instead of discarding it.
      const { written } = stashEntry({
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        prompt: text,
        attachments: [],
        droppedImageNames: [],
      });
      toastManager.add({
        type: written ? "info" : "error",
        title: written ? "Dictation stashed" : "Dictation could not be saved",
        description: written
          ? "The composer is busy, so the dictated text was added to the prompt stash."
          : "The composer is busy and the prompt stash could not be written.",
      });
    },
    [composerHandle, stashEntry],
  );

  const startingRef = useRef(false);
  const start = useCallback(() => {
    // sessionRef is only set after session startup resolves (getUserMedia,
    // worklet, ticket fetch — hundreds of ms), so it alone cannot guard
    // against a second toggle inside that window; the synchronous flag can.
    if (sessionRef.current !== null || startingRef.current) {
      return;
    }
    startingRef.current = true;
    setState("starting");
    setLiveText(null);
    setLastInsertion(null);

    void (async () => {
      try {
        heardSignalRef.current = false;
        setNoSignal(false);
        const silenceCheck = window.setTimeout(() => {
          if (!heardSignalRef.current) {
            setNoSignal(true);
          }
        }, 2500);
        const session = await startDictationSession({
          onLevel: (dbfs) => {
            setLevelDbfs(dbfs);
            if (dbfs > -70 && !heardSignalRef.current) {
              heardSignalRef.current = true;
              setNoSignal(false);
            }
          },
          onEvent: (event) => {
            switch (event.type) {
              case "ready":
                setState((current) => (current === "starting" ? "listening" : current));
                break;
              case "update":
                setState("listening");
                setLiveText({ committed: event.committed, tentative: event.tentative });
                break;
              case "final":
                break;
              case "error":
                toastManager.add({
                  type: "error",
                  title: "Dictation failed",
                  description: event.message,
                  // Persistent: these carry diagnostics worth reading and often
                  // appear when the user is not looking at the toast area.
                  timeout: 0,
                });
                break;
            }
          },
        });
        sessionRef.current = session;
        startingRef.current = false;
        // Capture began; show listening even before the sidecar reports ready
        // so the user knows the microphone is live.
        setState((current) => (current === "starting" ? "listening" : current));

        const result = await session.done;
        window.clearTimeout(silenceCheck);
        setNoSignal(false);
        sessionRef.current = null;
        setState("idle");
        setLiveText(null);
        setLevelDbfs(null);
        if (result.finalText !== null) {
          insertFinalText(result.finalText);
        }
      } catch (error) {
        // getUserMedia rejection: permission denied or no device.
        startingRef.current = false;
        sessionRef.current = null;
        setState("idle");
        setLiveText(null);
        toastManager.add({
          type: "error",
          title: "Microphone unavailable",
          description: error instanceof Error ? error.message : String(error),
          timeout: 0,
        });
      }
    })();
  }, [insertFinalText]);

  const stop = useCallback(() => {
    if (sessionRef.current === null) {
      return;
    }
    setState("finalizing");
    sessionRef.current.stop();
  }, []);

  const cancel = useCallback(() => {
    sessionRef.current?.cancel();
    sessionRef.current = null;
    setState("idle");
    setLiveText(null);
  }, []);

  const toggle = useCallback(() => {
    if (sessionRef.current === null) {
      start();
    } else {
      stop();
    }
  }, [start, stop]);

  // Never leave a live microphone behind an unmounted composer.
  useEffect(() => () => sessionRef.current?.cancel(), []);

  return { state, liveText, lastInsertion, levelDbfs, noSignal, start, stop, cancel, toggle };
}
