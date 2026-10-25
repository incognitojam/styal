import type { tokenCache } from "@clerk/expo/token-cache";

// Clerk can stay unloaded until restart: Android `fetch` has no timeout, Expo awaits a saved-token
// read that can stall before our timeout hook runs, and `@clerk/react` never retries a failed load.
// Both hooks use Clerk internals missing from its public types, so each checks for the member at
// runtime and does nothing when a Clerk upgrade removes it.

export const CLERK_REQUEST_TIMEOUT_MS = 15_000;
export const CLERK_TOKEN_READ_TIMEOUT_MS = 15_000;
export const CLERK_LOAD_RETRY_INITIAL_DELAY_MS = 2_000;
export const CLERK_LOAD_RETRY_MAX_DELAY_MS = 30_000;

interface ClerkRequestInit {
  method?: string;
  signal?: AbortSignal | null;
}

type ClerkStatusListener = (status: string) => void;

interface HeadlessClerkLoader {
  readonly loaded: boolean;
  readonly status: string | undefined;
  on(event: "status", listener: ClerkStatusListener): void;
  off(event: "status", listener: ClerkStatusListener): void;
  loadHeadlessClerk(): void;
}

const timedClerkInstances = new WeakSet<object>();

/**
 * A failed read must reject, rather than look like a missing token: returning null
 * would load a signed-out client and remove the user's saved relay environments.
 * Keep Expo's cache responsible for storage, and leave its contents untouched on
 * timeout so the next Clerk load can retry the read.
 */
export function recoverableClerkTokenCache(cache: NonNullable<typeof tokenCache>) {
  return {
    ...cache,
    getToken: async (key: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          cache.getToken(key),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("Reading the saved styal Link sign-in timed out.")),
              CLERK_TOKEN_READ_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Aborts Clerk GET requests that do not finish within the timeout, so a stalled
 * startup request fails and becomes eligible for {@link retryFailedClerkLoads}.
 * Call with the `getClerkInstance()` singleton before `ClerkProvider` renders,
 * because the provider starts loading during its first render.
 */
export function limitClerkRequestDuration(clerk: object): void {
  if (timedClerkInstances.has(clerk)) return;
  if (
    !("__internal_onBeforeRequest" in clerk) ||
    typeof clerk.__internal_onBeforeRequest !== "function"
  ) {
    return;
  }
  timedClerkInstances.add(clerk);
  clerk.__internal_onBeforeRequest((requestInit: ClerkRequestInit) => {
    if ((requestInit.method ?? "GET") !== "GET" || requestInit.signal) return;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), CLERK_REQUEST_TIMEOUT_MS);
    requestInit.signal = controller.signal;
  });
}

function isHeadlessClerkLoader(clerk: object): clerk is HeadlessClerkLoader {
  return (
    "loadHeadlessClerk" in clerk &&
    typeof clerk.loadHeadlessClerk === "function" &&
    "on" in clerk &&
    typeof clerk.on === "function" &&
    "off" in clerk &&
    typeof clerk.off === "function"
  );
}

/**
 * Reloads Clerk after each failed startup load, with exponential backoff capped at
 * {@link CLERK_LOAD_RETRY_MAX_DELAY_MS}. A pending retry runs immediately when the
 * app returns to the foreground. Takes the `useClerk()` instance, calls
 * `onLoadFailed` after each failed load, and returns a cleanup function.
 */
export function retryFailedClerkLoads(
  clerk: object,
  onAppActive: (listener: () => void) => () => void,
  onLoadFailed?: () => void,
): () => void {
  if (!isHeadlessClerkLoader(clerk)) return () => {};

  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const load = () => {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    if (!clerk.loaded) clerk.loadHeadlessClerk();
  };
  const handleStatus = (status: string | undefined) => {
    if (status !== "error" || retryTimer !== undefined) return;
    onLoadFailed?.();
    const delay = Math.min(
      CLERK_LOAD_RETRY_INITIAL_DELAY_MS * 2 ** failures,
      CLERK_LOAD_RETRY_MAX_DELAY_MS,
    );
    failures += 1;
    retryTimer = setTimeout(load, delay);
  };

  clerk.on("status", handleStatus);
  handleStatus(clerk.status);
  const removeAppActiveListener = onAppActive(() => {
    if (retryTimer !== undefined) load();
  });

  return () => {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    clerk.off("status", handleStatus);
    removeAppActiveListener();
  };
}
