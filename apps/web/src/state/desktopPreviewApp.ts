import { useAtomValue } from "@effect/atom-react";
import type {
  DesktopBridge,
  DesktopPreviewAppBuild,
  DesktopPreviewAppState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

const BUILD_LOOKUP_INTERVAL_MS = 60_000;

export function getDesktopPreviewAppBridge(): NonNullable<DesktopBridge["previewApp"]> | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.previewApp;
}

const desktopPreviewAppStateAtom = Atom.make(
  Stream.callback<DesktopPreviewAppState | null>((queue) =>
    Effect.gen(function* () {
      const bridge = getDesktopPreviewAppBridge();
      if (!bridge) {
        Queue.offerUnsafe(queue, null);
        return yield* Effect.never;
      }
      let receivedUpdate = false;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          bridge.onState((state) => {
            receivedUpdate = true;
            Queue.offerUnsafe(queue, state);
          }),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      const initial = yield* Effect.tryPromise(() => bridge.getState()).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (!receivedUpdate && initial !== null) Queue.offerUnsafe(queue, initial);
      return yield* Effect.never;
    }),
  ),
  { initialValue: null },
).pipe(Atom.keepAlive, Atom.withLabel("desktop:preview-app-state"));

export function useDesktopPreviewAppState(): DesktopPreviewAppState | null {
  return AsyncResult.getOrElse(useAtomValue(desktopPreviewAppStateAtom), () => null);
}

/**
 * The pull request's published build, or null. Looks again every minute while mounted, and at
 * once when `refreshKey` changes, because the release has no push signal for a finished build.
 */
export function useDesktopPreviewAppBuild(
  pullRequestNumber: number | null,
  refreshKey: string,
): DesktopPreviewAppBuild | null {
  const [found, setFound] = useState<DesktopPreviewAppBuild | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls GitHub's release assets through the desktop bridge while the pull request is on screen
  useEffect(() => {
    const bridge = getDesktopPreviewAppBridge();
    if (!bridge || pullRequestNumber === null) return;
    let cancelled = false;
    const look = () =>
      void bridge
        .findBuild(pullRequestNumber)
        .then((build) => {
          if (!cancelled) setFound(build);
        })
        .catch(() => undefined);
    look();
    const timer = window.setInterval(look, BUILD_LOOKUP_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refreshKey only restarts the lookup when a build may have finished
  }, [pullRequestNumber, refreshKey]);
  return found !== null && found.pullRequestNumber === pullRequestNumber ? found : null;
}
