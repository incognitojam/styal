import { useState } from "react";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import type { ImportSource, LegacyImportStage } from "../import/types";
import { DataImportPanel } from "../import/DataImportPanel";

/** Keep selections mounted across the top-level Projects and Preferences steps. */
export function OnboardingImportStep({
  active,
  environmentIds,
  stage,
  setIsImporting,
  onDone,
  onContinue,
  onBack,
  onPreferencesAvailable,
}: {
  readonly active: boolean;
  readonly environmentIds: readonly EnvironmentId[];
  readonly stage: LegacyImportStage;
  readonly setIsImporting: (value: boolean) => void;
  readonly onDone: (projectRef?: ScopedProjectRef) => Promise<boolean>;
  readonly onContinue: () => void;
  readonly onBack: () => void;
  readonly onPreferencesAvailable: (available: boolean) => void;
}) {
  const [source, setSource] = useState<ImportSource | null>(null);
  return (
    <DataImportPanel
      active={active}
      source={source}
      onSourceChange={setSource}
      stage={stage}
      onBack={stage === "preferences" ? onBack : () => setSource(null)}
      onContinue={onContinue}
      onPreferencesAvailable={onPreferencesAvailable}
      environmentIds={environmentIds}
      onBusyChange={setIsImporting}
      onDone={onDone}
    />
  );
}
