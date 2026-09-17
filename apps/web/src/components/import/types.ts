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
}

export interface ImportSourceModel {
  readonly title: string;
  readonly projects: readonly ImportProjectRow[];
  readonly pending: boolean;
  readonly message?: string | undefined;
  readonly error?: string | null | undefined;
  readonly notice?: string | undefined;
  readonly refresh: () => void;
  readonly select: (ids: ReadonlySet<string>) => void;
}

export interface ImportPreferencesModel {
  readonly changes: readonly PreferenceComparisonRow[];
  readonly selected: boolean;
  readonly select: (selected: boolean) => void;
  readonly message?: string | undefined;
  readonly error?: string | null | undefined;
}

export interface ComputerImportSummary {
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
