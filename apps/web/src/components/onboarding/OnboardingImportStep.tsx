import { useState } from "react";
import { ImportSourceChooser } from "../import/ImportSourceChooser";
import type { ImportSource } from "../import/types";
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
  const [source, setSource] = useState<ImportSource | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skip = async () => {
    if (finishing) return;
    setFinishing(true);
    setIsImporting(true);
    setError(null);
    try {
      await onDone();
    } catch {
      setError("Could not finish setup. Please try again.");
    } finally {
      setFinishing(false);
      setIsImporting(false);
    }
  };
  if (source === null)
    return (
      <ImportSourceChooser
        onSelect={setSource}
        onSkip={() => void skip()}
        busy={finishing}
        error={error}
      />
    );
  return (
    <DataImportPanel
      key={source}
      source={source}
      onBack={() => setSource(null)}
      environmentIds={environmentIds}
      onBusyChange={setIsImporting}
      onDone={onDone}
    />
  );
}
