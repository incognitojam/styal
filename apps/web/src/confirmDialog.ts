import type { ConfirmDialogOptions, ConfirmDialogVariant } from "@t3tools/contracts";

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | {
      readonly status: "confirming";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly confirmLabel: string;
      readonly threadActivity?: ConfirmDialogOptions["threadActivity"];
    }
  | {
      readonly status: "closing";
      readonly message: string;
      readonly variant: ConfirmDialogVariant;
      readonly confirmLabel: string;
      readonly threadActivity?: ConfirmDialogOptions["threadActivity"];
    };

type PendingConfirmation = {
  readonly message: string;
  readonly variant: ConfirmDialogVariant;
  readonly confirmLabel: string;
  readonly threadActivity?: ConfirmDialogOptions["threadActivity"];
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
  publish({
    status: "confirming",
    message: pending.message,
    variant: pending.variant,
    confirmLabel: pending.confirmLabel,
    ...(pending.threadActivity ? { threadActivity: pending.threadActivity } : {}),
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

export function subscribeConfirmDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

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

/** Undefined means no themed host is available. */
export function requestConfirmDialog(
  message: string,
  options?: ConfirmDialogOptions,
  lifecycle?: {
    readonly onPresented?: () => void;
    readonly signal?: AbortSignal;
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

export function isConfirmDialogActive(): boolean {
  return state.status !== "idle" || activeConfirmation !== null || queuedConfirmations.length > 0;
}

export function respondToConfirmDialog(confirmed: boolean): void {
  if (state.status !== "confirming" || !activeConfirmation) return;

  const confirmation = activeConfirmation;
  activeConfirmation = null;
  confirmation.resolve(confirmed);
  publish({
    status: "closing",
    message: state.message,
    variant: state.variant,
    confirmLabel: state.confirmLabel,
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
