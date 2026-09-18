import { useEffect, useSyncExternalStore } from "react";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  requestConfirmDialog,
  respondToConfirmDialog,
  subscribeConfirmDialog,
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

type ConfirmationCopy = {
  readonly title: string;
  readonly description: string | null;
};

export function resolveConfirmDialogCopy(message: string): ConfirmationCopy {
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
    subscribeConfirmDialog,
    readConfirmDialogState,
    readConfirmDialogState,
  );

  useEffect(() => registerConfirmDialogHost(), []);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.onShutdownConfirmation) return;
    let disposed = false;
    let latestRequestId = 0;
    const show: Parameters<typeof bridge.onShutdownConfirmation>[0] = (request) => {
      if (disposed || request.requestId <= latestRequestId) return;
      latestRequestId = request.requestId;
      void (async () => {
        const confirmed = await (requestConfirmDialog(request.message) ?? false);
        await bridge.resolveShutdownConfirmation(request.requestId, confirmed);
      })().catch(() => {
        /* A closing renderer may lose its IPC connection. */
      });
    };
    const unsubscribe = bridge.onShutdownConfirmation(show);
    void bridge
      .getShutdownConfirmation()
      .then((request) => {
        if (request) show(request);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const copy = resolveConfirmDialogCopy(state.status === "idle" ? "" : state.message);
  const confirmVariant = state.status === "idle" ? "default" : state.variant;
  const onCancel = () => respondToConfirmDialog(false);
  const onConfirm = () => respondToConfirmDialog(true);

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
      <AlertDialogPopup className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          {copy.description ? (
            <AlertDialogDescription className="whitespace-pre-line">
              {copy.description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant={confirmVariant} onClick={onConfirm}>
            Confirm
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
