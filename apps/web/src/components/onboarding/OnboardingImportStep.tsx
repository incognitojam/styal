import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { DataImportPanel } from "../import/DataImportPanel";

export function OnboardingImportStep({
  environmentIds,
  setIsImporting,
  onDone,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly setIsImporting: (value: boolean) => void;
  readonly onDone: (projectRef?: ScopedProjectRef) => Promise<boolean>;
}) {
  return (
    <DataImportPanel
      environmentIds={environmentIds}
      onBusyChange={setIsImporting}
      onDone={onDone}
    />
  );
}
