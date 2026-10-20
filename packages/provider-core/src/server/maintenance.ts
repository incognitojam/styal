import type { ProviderDriverKind } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
  /**
   * `undefined` means the installer has no channel of its own and the npm
   * registry entry for `packageName` is authoritative; `null` means the
   * installer was asked and did not know.
   */
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
  /**
   * The executable T3 Code runs, symlinks followed, when no update command is
   * proven for it. The version advisory names it so the user knows which
   * install to update.
   */
  readonly installPath?: string;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  /**
   * A native updater finds its install through the same variables the
   * provider runs with (e.g. `CODEX_HOME`), so an instance with a custom home
   * must update that home and not the default one.
   */
  readonly env?: NodeJS.ProcessEnv;
}
