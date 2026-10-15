import type { PreviewAutomationOperation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Toolkit } from "effect/unstable/ai";

import type { PreviewStandardToolkit } from "../mcp/toolkits/preview/tools.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as FeatureUsage from "./FeatureUsage.ts";

type Handlers = Toolkit.HandlersFrom<Toolkit.Tools<typeof PreviewStandardToolkit>>;

const observer = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  return <A, E, R>(action: PreviewAutomationOperation, effect: Effect.Effect<A, E, R>) =>
    FeatureUsage.observe({ feature: "browser-tools", action, source: "agent" }, effect).pipe(
      Effect.provideService(AnalyticsService.AnalyticsService, analytics),
    );
});

/** Wrap public handlers, leaving their internal status reads unobserved. */
export const observeHandlers = Effect.fnUntraced(function* (handlers: Handlers) {
  const observe = yield* observer;
  return {
    preview_status: (input, context) => observe("status", handlers.preview_status(input, context)),
    preview_open: (input, context) => observe("open", handlers.preview_open(input, context)),
    preview_navigate: (input, context) =>
      observe("navigate", handlers.preview_navigate(input, context)),
    preview_resize: (input, context) => observe("resize", handlers.preview_resize(input, context)),
    preview_set_appearance: (input, context) =>
      observe("setColorScheme", handlers.preview_set_appearance(input, context)),
    preview_click: (input, context) => observe("click", handlers.preview_click(input, context)),
    preview_type: (input, context) => observe("type", handlers.preview_type(input, context)),
    preview_press: (input, context) => observe("press", handlers.preview_press(input, context)),
    preview_scroll: (input, context) => observe("scroll", handlers.preview_scroll(input, context)),
    preview_evaluate: (input, context) =>
      observe("evaluate", handlers.preview_evaluate(input, context)),
    preview_wait_for: (input, context) =>
      observe("waitFor", handlers.preview_wait_for(input, context)),
    preview_recording_start: (input, context) =>
      observe("recordingStart", handlers.preview_recording_start(input, context)),
    preview_recording_stop: (input, context) =>
      observe("recordingStop", handlers.preview_recording_stop(input, context)),
  } satisfies Handlers;
});

// Snapshot observation belongs outside the toolkit so it includes encoding and file saving.
export const snapshotObserver = observer.pipe(
  Effect.map(
    (observe) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        observe("snapshot", effect),
  ),
);
