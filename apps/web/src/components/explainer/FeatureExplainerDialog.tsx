import * as Schema from "effect/Schema";
import { PlayIcon, RotateCcwIcon } from "lucide-react";
import { type ReactNode, use, useEffect, useState } from "react";

import { readLocalStorageValue, writeLocalStorageValue } from "~/hooks/useLocalStorage";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ControlledOpenContext, Dialog, DialogAction } from "../ui/dialog";
import { WizardFooter, WizardHeader, WizardPopup } from "../ui/wizard";
import { Scene } from "./explainerScene";
import {
  EXPLAINER_STEP_MS,
  explainerOpening,
  FEATURE_EXPLAINERS_SEEN_STORAGE_KEY,
  type FeatureExplainer,
  firstSceneStep,
  nextSceneStep,
} from "./featureExplainer.logic";

const SeenFeatures = Schema.Array(Schema.String);
// Keeps an explainer from reopening in this session when storage refuses the write.
const seenThisSession = new Set<string>();

/**
 * Opens an explainer from its link, or once per device when its feature is first turned on.
 * `scope` is a line under the last slide saying where the feature is on, read when it renders.
 */
export function useFeatureExplainer(explainer: FeatureExplainer, scope?: ReactNode) {
  const [open, setOpen] = useState(false);
  const request = (trigger: "enabled" | "link") => {
    const stored = readLocalStorageValue(FEATURE_EXPLAINERS_SEEN_STORAGE_KEY, [], SeenFeatures);
    const seen = [...new Set([...stored, ...seenThisSession])];
    const decision = explainerOpening(seen, explainer.feature, trigger);
    seenThisSession.add(explainer.feature);
    if (!stored.includes(explainer.feature)) {
      writeLocalStorageValue(FEATURE_EXPLAINERS_SEEN_STORAGE_KEY, decision.seen, [], SeenFeatures);
    }
    if (decision.open) setOpen(true);
  };
  return {
    dialog: (
      <FeatureExplainerDialog
        explainer={explainer}
        scope={scope}
        open={open}
        onOpenChange={setOpen}
      />
    ),
    link: (
      <Button variant="ghost-muted" size="xs" onClick={() => request("link")}>
        <PlayIcon />
        See how it works
      </Button>
    ),
    show: () => request("link"),
    onEnabled: () => request("enabled"),
  };
}

function FeatureExplainerDialog({
  explainer,
  scope,
  open,
  onOpenChange,
}: {
  readonly explainer: FeatureExplainer;
  readonly scope: ReactNode;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <WizardPopup aria-label={explainer.title}>
        {open ? (
          <Slides explainer={explainer} scope={scope} onDone={() => onOpenChange(false)} />
        ) : null}
      </WizardPopup>
    </Dialog>
  );
}

function Slides({
  explainer,
  scope,
  onDone,
}: {
  readonly explainer: FeatureExplainer;
  readonly scope: ReactNode;
  readonly onDone: () => void;
}) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  // The popup keeps this subtree mounted while it animates closed; playback stops at once.
  const open = use(ControlledOpenContext) !== false;
  const [index, setIndex] = useState(0);
  const [playCount, setPlayCount] = useState(0);
  const slide = explainer.slides[index]!;
  const last = index === explainer.slides.length - 1;
  const { Scene: SlideScene } = slide;
  const playKey = `${index}:${playCount}:${reducedMotion}`;
  const [playback, setPlayback] = useState({
    key: playKey,
    step: firstSceneStep(slide.steps, reducedMotion),
  });
  if (playback.key !== playKey) {
    setPlayback({ key: playKey, step: firstSceneStep(slide.steps, reducedMotion) });
  }
  const next = nextSceneStep(playback.step, slide.steps);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- advances the scene on a timer; the timer is cleared when the slide changes, replays or closes
  useEffect(() => {
    const step = nextSceneStep(playback.step, slide.steps);
    if (step === null || !open) return;
    const timer = window.setTimeout(
      () => setPlayback((current) => ({ ...current, step })),
      EXPLAINER_STEP_MS,
    );
    return () => window.clearTimeout(timer);
  }, [playback, slide.steps, open]);

  return (
    <>
      <div className="px-2 pt-2">
        <Scene.Stage>
          <SlideScene key={playKey} step={playback.step} />
        </Scene.Stage>
      </div>
      <WizardHeader
        title={slide.title}
        description={
          <span className="flex max-w-prose flex-col gap-1.5">
            <span>{slide.lines[0]}</span>
            <span>{slide.lines[1]}</span>
          </span>
        }
      >
        {last && scope ? (
          <p className="mt-1.5 border-t pt-3 text-xs text-muted-foreground">{scope}</p>
        ) : null}
      </WizardHeader>
      <WizardFooter
        leading={
          <div className="flex items-center gap-3">
            <div
              className="flex items-center gap-0.5"
              aria-label={`Slide ${index + 1} of ${explainer.slides.length}`}
            >
              {explainer.slides.map((candidate, dot) => (
                <button
                  key={candidate.title}
                  type="button"
                  aria-label={`Slide ${dot + 1}: ${candidate.title}`}
                  aria-current={dot === index ? "step" : undefined}
                  onClick={() => setIndex(dot)}
                  className="group/dot grid h-5 place-items-center rounded-sm px-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <span
                    className={cn(
                      "h-1.5 rounded-full",
                      dot === index
                        ? "w-4 bg-foreground"
                        : "w-1.5 bg-foreground/20 group-hover/dot:bg-foreground/40",
                    )}
                  />
                </button>
              ))}
            </div>
            {slide.steps > 1 && next === null && !reducedMotion ? (
              <Button
                variant="ghost-muted"
                size="xs"
                onClick={() => setPlayCount((count) => count + 1)}
              >
                <RotateCcwIcon />
                Replay
              </Button>
            ) : null}
          </div>
        }
      >
        <Button
          variant="ghost-muted"
          size="sm"
          render={<a href={explainer.guideUrl} target="_blank" rel="noreferrer" />}
        >
          Read the guide
        </Button>
        {index > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setIndex(index - 1)}>
            Back
          </Button>
        ) : null}
        <DialogAction size="sm" onClick={() => (last ? onDone() : setIndex(index + 1))}>
          {last ? "Done" : "Next"}
        </DialogAction>
      </WizardFooter>
    </>
  );
}
