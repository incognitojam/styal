import { useEffect, useSyncExternalStore } from "react";

import {
  acknowledgeConfirmDialogPresentation,
  completeConfirmDialogClose,
  confirmActiveConfirmDialog,
  readConfirmDialogState,
  requestConfirmDialog,
  respondToConfirmDialog,
  subscribeConfirmDialogHost,
} from "../confirmDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { HostActivityThreadList } from "./HostActivityThreadList";
import { Spinner } from "./ui/spinner";
import { StableLabel } from "./StableLabel";

type ConfirmationCopy = {
  readonly title: string;
  readonly description: string | null;
};

function resolveConfirmDialogCopy(message: string): ConfirmationCopy {
  const normalizedMessage = message.trim();
  const lines = normalizedMessage.split("\n");
  const questionLineIndex = lines.findIndex((line) => line.trim().endsWith("?"));

  if (questionLineIndex >= 0) {
    const title = lines[questionLineIndex]!.trim();
    const description = lines
      .filter((_, index) => index !== questionLineIndex)
      .join("\n")
      .trim();
    return { title, description: description || null };
  }

  const questionMarkIndex = normalizedMessage.indexOf("?");
  if (questionMarkIndex >= 0) {
    return {
      title: normalizedMessage.slice(0, questionMarkIndex + 1).trim(),
      description: normalizedMessage.slice(questionMarkIndex + 1).trim() || null,
    };
  }

  return {
    title: "Confirm action",
    description: normalizedMessage || "This action requires your confirmation.",
  };
}

export function ConfirmDialogHost() {
  const state = useSyncExternalStore(
    subscribeConfirmDialogHost,
    readConfirmDialogState,
    readConfirmDialogState,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- acknowledges dialog presentation to the imperative confirmation request registry
  useEffect(() => {
    acknowledgeConfirmDialogPresentation(state);
  }, [state]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to desktop shutdown confirmation IPC and releases pending requests on unmount
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.onShutdownConfirmation) return;
    let disposed = false;
    let latestRequestId = 0;
    const requests = new Map<number, AbortController>();
    const show: Parameters<typeof bridge.onShutdownConfirmation>[0] = (request) => {
      if (disposed || request.requestId <= latestRequestId) return;
      latestRequestId = request.requestId;
      const controller = new AbortController();
      requests.set(request.requestId, controller);
      void (async () => {
        const options = {
          ...(request.confirmLabel ? { confirmLabel: request.confirmLabel } : {}),
          ...(request.threadActivity ? { threadActivity: request.threadActivity } : {}),
        };
        const confirmed = await (requestConfirmDialog(request.message, options, {
          signal: controller.signal,
          onPresented: () => {
            void bridge.acknowledgeShutdownConfirmation(request.requestId).catch(() => {});
          },
        }) ?? false);
        await bridge.resolveShutdownConfirmation(request.requestId, confirmed);
      })()
        .catch(() => {
          // A closing renderer may lose its IPC connection.
        })
        .finally(() => requests.delete(request.requestId));
    };
    const unsubscribe = bridge.onShutdownConfirmation(show);
    const unsubscribeExpired = bridge.onShutdownConfirmationExpired((requestId) => {
      latestRequestId = Math.max(latestRequestId, requestId);
      requests.get(requestId)?.abort();
      // Processing expiry proves this host has recovered, even after a stalled render.
      void bridge.shutdownRendererReady().catch(() => {});
    });
    void bridge.shutdownRendererReady().catch(() => {});
    void bridge
      .getShutdownConfirmation()
      .then((request) => {
        if (request) show(request);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeExpired();
      for (const controller of requests.values()) controller.abort();
    };
  }, []);

  const copy = resolveConfirmDialogCopy(state.status === "idle" ? "" : state.message);
  const confirmVariant = state.status === "idle" ? "default" : state.variant;
  const threadActivity = state.status === "idle" ? undefined : state.threadActivity;
  const onCancel = () => respondToConfirmDialog(false);
  const onConfirm = () => confirmActiveConfirmDialog();
  const checking = state.status !== "idle" && state.checking === true;
  const confirmLabel = state.status === "idle" ? "Confirm" : state.confirmLabel;
  const previousConfirmLabel = state.status === "idle" ? undefined : state.previousConfirmLabel;

  return (
    <AlertDialog
      open={state.status === "confirming"}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) completeConfirmDialogClose();
      }}
    >
      <AlertDialogPopup>
        {/* With a thread list, a long description scrolls within 40% of the viewport so the list keeps room. */}
        <div
          className={
            threadActivity?.length
              ? "max-h-[40dvh] shrink-0 overflow-y-auto"
              : "min-h-0 overflow-y-auto"
          }
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.title}</AlertDialogTitle>
            {copy.description ? (
              <div className="flex items-start gap-2">
                {checking ? (
                  <span className="pt-0.5">
                    <Spinner size="sm" tone="muted" aria-label="Checking" />
                  </span>
                ) : null}
                <AlertDialogDescription className="whitespace-pre-line">
                  {copy.description}
                </AlertDialogDescription>
              </div>
            ) : null}
          </AlertDialogHeader>
        </div>
        {threadActivity?.length ? <HostActivityThreadList activity={threadActivity} /> : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant={confirmVariant} onClick={onConfirm}>
            <StableLabel label={confirmLabel} previous={previousConfirmLabel} />
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
