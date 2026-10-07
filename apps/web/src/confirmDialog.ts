import type { ConfirmDialogOptions, ConfirmDialogVariant } from "@t3tools/contracts";

type ConfirmDialogContent = {
  readonly message: string;
  readonly threadActivity?: ConfirmDialogOptions["threadActivity"];
};

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | {
      readonly status: "confirming";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly confirmLabel: string;
      readonly loading?: boolean;
      readonly threadActivity?: ConfirmDialogOptions["threadActivity"];
    }
  | {
      readonly status: "closing";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly confirmLabel: string;
      readonly loading?: boolean;
      readonly threadActivity?: ConfirmDialogOptions["threadActivity"];
    };

type PendingConfirmation = {
  message: string;
  readonly variant: ConfirmDialogVariant;
  readonly confirmLabel: string;
  threadActivity?: ConfirmDialogOptions["threadActivity"];
  readonly prepare?: () => Promise<ConfirmDialogContent | null>;
  loading: boolean;
  readonly resolve: (confirmed: boolean) => void;
  readonly onPresented?: () => void;
  presented: boolean;
};

const idleState: ConfirmDialogState = { status: "idle" };
let state: ConfirmDialogState = idleState;
let activeConfirmation: PendingConfirmation | null = null;
let queuedConfirmations: PendingConfirmation[] = [];
let registeredHostCount = 0;
const listeners = new Set<() => void>();

function publish(next: ConfirmDialogState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function presentConfirmation(pending: PendingConfirmation): void {
  activeConfirmation = pending;
  const publishConfirmation = () =>
    publish({
      status: "confirming",
      message: pending.message,
      variant: pending.variant,
      confirmLabel: pending.confirmLabel,
      ...(pending.loading ? { loading: true } : {}),
      ...(pending.threadActivity ? { threadActivity: pending.threadActivity } : {}),
    });
  publishConfirmation();
  if (!pending.prepare) return;
  void pending.prepare().then(
    (content) => {
      // Cancellation, host teardown, or expiry must not revive this dialog.
      if (activeConfirmation !== pending) return;
      pending.loading = false;
      if (content === null) {
        respondToConfirmDialog(true);
        // A fast check can finish before React commits the open dialog, so
        // there may be no close transition to advance the queue.
        if (!pending.presented) completeConfirmDialogClose();
        return;
      }
      pending.message = content.message;
      pending.threadActivity = content.threadActivity;
      publishConfirmation();
    },
    () => {
      if (activeConfirmation === pending) respondToConfirmDialog(false);
    },
  );
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

export function subscribeConfirmDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Registers the renderer host that can present themed confirmations. The
 * returned cleanup function also cancels any request left without a host.
 */
export function registerConfirmDialogHost(): () => void {
  registeredHostCount += 1;
  let registered = true;

  return () => {
    if (!registered) return;
    registered = false;
    registeredHostCount = Math.max(0, registeredHostCount - 1);

    if (registeredHostCount === 0) {
      resolvePendingConfirmations(false);
      publish(idleState);
    }
  };
}

/**
 * Requests a themed confirmation when a host is mounted. An undefined result
 * means no themed host is currently available.
 */
export function requestConfirmDialog(
  message: string,
  options?: ConfirmDialogOptions,
  lifecycle?: {
    readonly onPresented?: () => void;
    readonly signal?: AbortSignal;
    /** Shows the dialog immediately; null proceeds without further confirmation. */
    readonly prepare?: () => Promise<ConfirmDialogContent | null>;
  },
): Promise<boolean> | undefined {
  if (registeredHostCount === 0) return undefined;
  if (lifecycle?.signal?.aborted) return Promise.resolve(false);

  const confirmation = new Promise<boolean>((resolve) => {
    const pending = {
      message,
      variant: options?.variant ?? "default",
      confirmLabel: options?.confirmLabel ?? "Confirm",
      ...(options?.threadActivity ? { threadActivity: options.threadActivity } : {}),
      resolve: (confirmed: boolean) => {
        lifecycle?.signal?.removeEventListener("abort", cancel);
        resolve(confirmed);
      },
      ...(lifecycle?.onPresented ? { onPresented: lifecycle.onPresented } : {}),
      ...(lifecycle?.prepare ? { prepare: lifecycle.prepare } : {}),
      loading: lifecycle?.prepare !== undefined,
      presented: false,
    } satisfies PendingConfirmation;
    function cancel() {
      if (activeConfirmation === pending) {
        respondToConfirmDialog(false);
      } else {
        queuedConfirmations = queuedConfirmations.filter((entry) => entry !== pending);
        pending.resolve(false);
      }
    }
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

/** True while a confirmation is shown, closing, or waiting to be shown. */
export function isConfirmDialogActive(): boolean {
  return state.status !== "idle" || activeConfirmation !== null || queuedConfirmations.length > 0;
}

export function respondToConfirmDialog(confirmed: boolean): void {
  if (state.status !== "confirming" || !activeConfirmation) return;
  if (confirmed && activeConfirmation.loading) return;

  const confirmation = activeConfirmation;
  activeConfirmation = null;
  confirmation.resolve(confirmed);
  publish({
    status: "closing",
    message: state.message,
    variant: state.variant,
    confirmLabel: state.confirmLabel,
    ...(state.loading ? { loading: true } : {}),
    ...(state.threadActivity ? { threadActivity: state.threadActivity } : {}),
  });
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
  resolvePendingConfirmations(false);
  registeredHostCount = 0;
  publish(idleState);
  listeners.clear();
}
