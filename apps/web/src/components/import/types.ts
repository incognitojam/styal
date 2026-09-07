import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import type { PreferenceComparisonRow } from "../settings/DataImportSettings.logic";

export type ImportSource = "legacy" | "history";
export type LegacyImportStage = "projects" | "preferences";

export interface ImportOutcome {
  readonly success: boolean;
  readonly projectRef?: ScopedProjectRef | undefined;
}

export interface ImportProjectRow {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly threads: number;
  readonly selected: boolean;
  readonly detail?: string | undefined;
  readonly legacyFavicon?: {
    readonly environmentId: EnvironmentId;
    readonly projectId: string;
  };
  readonly providers?: readonly ("claudeAgent" | "codex")[] | undefined;
  readonly lastActiveAt?: string | null | undefined;
}

/**
 * Rows shown together under one heading. A repository group holds the clones
 * of one repository; the "other" group holds folders that are not git
 * repositories and starts folded.
 */
export interface ImportProjectGroup {
  readonly key: string;
  readonly kind: "repository" | "other";
  readonly label: string;
  readonly ids: readonly string[];
}

export interface ImportSourceModel {
  readonly title: string;
  readonly projects: readonly ImportProjectRow[];
  /** When set, rows render under these headings in this order. */
  readonly groups?: readonly ImportProjectGroup[] | undefined;
  readonly pending: boolean;
  readonly message?: string | undefined;
  readonly error?: string | null | undefined;
  readonly notice?: string | undefined;
  readonly refresh: () => void;
  readonly select: (ids: ReadonlySet<string>) => void;
}

export interface ImportPreferencesModel {
  readonly matches: boolean;
  readonly changes: readonly PreferenceComparisonRow[];
  readonly selected: boolean;
  readonly select: (selected: boolean) => void;
  readonly message?: string | undefined;
  readonly error?: string | null | undefined;
}

export interface ComputerImportSummary {
  readonly preferenceChanges?: number;
  readonly previewPending?: boolean;
  readonly projects: number;
  readonly threads: number;
  readonly preferences: number;
}

export interface ComputerImporter {
  readonly run: () => Promise<ImportOutcome>;
}

export interface ImportComputerOption {
  readonly id: EnvironmentId;
  readonly label: string;
}
