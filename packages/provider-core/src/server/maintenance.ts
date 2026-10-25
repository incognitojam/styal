import type { ProviderDriverKind } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
  /** undefined defers to npm; null means the installer could not determine the latest version. */
  readonly latestVersion?: string | null;
  /**
   * Deferred until update checks are enabled; `null` falls back to
   * `latestVersion`, then npm.
   */
  readonly lookupLatestVersion?: Effect.Effect<string | null>;
  readonly compareVersions?: (current: string, latest: string) => number;
  /**
   * The provider's own installer set to install exactly `version`, for a
   * proven native install whose updater can only move to the latest release.
   * Background updates use it to install a tested version; a manual update
   * still runs `update`.
   */
  readonly pinnedUpdate?: (version: string) => ProviderMaintenanceCommandAction;
  /**
   * Whether the provider's own scheduled updater still owns a pinnable native
   * install: null when it could not be read, absent when the installer has no
   * updater styal can detect. Background updates reinstall the tested version
   * over an active one, which hands updates to styal.
   */
  readonly selfUpdaterActive?: boolean | null;
  /**
   * Switches the provider's own updater, for a pinnable native install whose
   * installer leaves it on. `turnOff` runs after a successful background
   * install; `handBack` after a successful manual update while managed
   * updates are off, and undoes only what `turnOff` changed. Neither fails.
   */
  readonly selfUpdater?: {
    readonly turnOff: Effect.Effect<void>;
    readonly handBack: Effect.Effect<void>;
  };
  /** Resolved executable path for advisories when no update command is proven. */
  readonly installPath?: string;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  /** Native updaters must use the instance's custom home (e.g. `CODEX_HOME`). */
  readonly env?: NodeJS.ProcessEnv;
}
