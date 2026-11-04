import type { ConfirmDialogOptions, ConfirmDialogVariant } from "@t3tools/contracts";

type ConfirmDialogContent = {
  readonly message: string;
  readonly variant: ConfirmDialogVariant;
  readonly confirmLabel: string;
  readonly threadActivity?: ConfirmDialogOptions["threadActivity"];
  /** The dialog is waiting for content that replaces it. */
  readonly checking?: true;
  /** A label the confirm button showed before, kept so the button does not resize. */
  readonly previousConfirmLabel?: string;
};

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | ({ readonly status: "confirming" } & ConfirmDialogContent)
  | ({ readonly status: "closing" } & ConfirmDialogContent);

// A click aimed at the previous content must not confirm the new content.
export const CONTENT_UPDATE_CLICK_GUARD_MS = 500;

type PendingConfirmation = {
  message: string;
  variant: ConfirmDialogVariant;
  confirmLabel: string;
  threadActivity?: ConfirmDialogOptions["threadActivity"];
  checking: boolean;
  previousConfirmLabel?: string;
  contentUpdatedAt?: number;
  readonly resolve: (confirmed: boolean) => void;
  readonly onPresented?: () => void;
  presented: boolean;
};

const idleState: ConfirmDialogState = { status: "idle" };
let state: ConfirmDialogState = idleState;
let activeConfirmation: PendingConfirmation | null = null;
let queuedConfirmations: PendingConfirmation[] = [];
const listeners = new Set<() => void>();

function publish(next: ConfirmDialogState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function presentConfirmation(pending: PendingConfirmation): void {
  activeConfirmation = pending;
  publish({
    status: "confirming",
    message: pending.message,
    variant: pending.variant,
    confirmLabel: pending.confirmLabel,
    ...(pending.threadActivity ? { threadActivity: pending.threadActivity } : {}),
    ...(pending.checking ? { checking: true } : {}),
    ...(pending.previousConfirmLabel ? { previousConfirmLabel: pending.previousConfirmLabel } : {}),
  });
}

function resolvePendingConfirmations(confirmed: boolean): void {
  activeConfirmation?.resolve(confirmed);
  for (const confirmation of queuedConfirmations) {
    confirmation.resolve(confirmed);
  }
  activeConfirmation = null;
  queuedConfirmations = [];
}

export function readConfirmDialogState(): ConfirmDialogState {
  return state;
}

/**
 * Only themed hosts subscribe, so a subscriber is a mounted host. When the last
 * one leaves, pending confirmations resolve as cancelled.
 */
export function subscribeConfirmDialogHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    resolvePendingConfirmations(false);
    publish(idleState);
  };
}

/** Undefined means no themed host is available. */
export function requestConfirmDialog(
  message: string,
  options?: ConfirmDialogOptions,
  lifecycle?: {
    readonly onPresented?: () => void;
    readonly signal?: AbortSignal;
    /** Shows that the content is still being checked until `bindContentUpdate` replaces it. */
    readonly checking?: boolean;
    /** Receives a function that replaces the dialog's content until it is answered. */
    readonly bindContentUpdate?: (
      update: (message: string, options?: ConfirmDialogOptions) => void,
    ) => void;
  },
): Promise<boolean> | undefined {
  if (listeners.size === 0) return undefined;
  if (lifecycle?.signal?.aborted) return Promise.resolve(false);

  const confirmation = new Promise<boolean>((resolve) => {
    const pending: PendingConfirmation = {
      message,
      variant: options?.variant ?? "default",
      confirmLabel: options?.confirmLabel ?? "Confirm",
      ...(options?.threadActivity ? { threadActivity: options.threadActivity } : {}),
      checking: lifecycle?.checking === true,
      resolve: (confirmed: boolean) => {
        lifecycle?.signal?.removeEventListener("abort", cancel);
        resolve(confirmed);
      },
      ...(lifecycle?.onPresented ? { onPresented: lifecycle.onPresented } : {}),
      presented: false,
    };
    function cancel() {
      if (activeConfirmation === pending) {
        respondToConfirmDialog(false);
      } else {
        queuedConfirmations = queuedConfirmations.filter((entry) => entry !== pending);
        pending.resolve(false);
      }
    }
    lifecycle?.bindContentUpdate?.((nextMessage, nextOptions) => {
      const nextLabel = nextOptions?.confirmLabel ?? "Confirm";
      const visible = activeConfirmation === pending && state.status === "confirming";
      if (visible && nextLabel !== pending.confirmLabel) {
        pending.previousConfirmLabel = pending.confirmLabel;
      }
      pending.message = nextMessage;
      pending.variant = nextOptions?.variant ?? "default";
      pending.confirmLabel = nextLabel;
      pending.checking = false;
      if (nextOptions?.threadActivity) pending.threadActivity = nextOptions.threadActivity;
      else delete pending.threadActivity;
      if (visible) {
        pending.contentUpdatedAt = Date.now();
        presentConfirmation(pending);
      }
    });
    lifecycle?.signal?.addEventListener("abort", cancel, { once: true });
    if (activeConfirmation || state.status === "closing") {
      queuedConfirmations.push(pending);
      return;
    }

    presentConfirmation(pending);
  });

  return confirmation;
}

/** Called after the host commits the active dialog, never when merely queued. */
export function acknowledgeConfirmDialogPresentation(renderedState: ConfirmDialogState): void {
  if (
    renderedState !== state ||
    state.status !== "confirming" ||
    !activeConfirmation ||
    activeConfirmation.presented
  )
    return;
  activeConfirmation.presented = true;
  activeConfirmation.onPresented?.();
}

export function isConfirmDialogActive(): boolean {
  return state.status !== "idle" || activeConfirmation !== null || queuedConfirmations.length > 0;
}

export function respondToConfirmDialog(confirmed: boolean): void {
  if (state.status !== "confirming" || !activeConfirmation) return;

  const confirmation = activeConfirmation;
  activeConfirmation = null;
  confirmation.resolve(confirmed);
  publish({ ...state, status: "closing" });
}

/** The confirm button's answer; ignored briefly after the dialog's content changed. */
export function confirmActiveConfirmDialog(): void {
  const updatedAt = activeConfirmation?.contentUpdatedAt;
  if (updatedAt !== undefined && Date.now() - updatedAt < CONTENT_UPDATE_CLICK_GUARD_MS) return;
  respondToConfirmDialog(true);
}

export function completeConfirmDialogClose(): void {
  if (state.status !== "closing") return;

  const next = queuedConfirmations.shift();
  if (!next) {
    publish(idleState);
    return;
  }

  presentConfirmation(next);
}

export function resetConfirmDialogForTests(): void {
  listeners.clear();
  resolvePendingConfirmations(false);
  publish(idleState);
}
