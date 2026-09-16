import { useCallback, useState } from "react";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";

import { DataImportPanel } from "../settings/DataImportSettings";
import { Button } from "../ui/button";
import { HistoryImportStep } from "./HistoryImportStep";
import { ImportSourceHeader, ImportSourcePicker, type ImportSource } from "./ImportSourcePicker";

/** Keep source failures independent and let setup import from both sources before finishing. */
export function OnboardingImportStep({
  environmentIds,
  isImporting,
  setIsImporting,
  onDone,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly isImporting: boolean;
  readonly setIsImporting: (value: boolean) => void;
  readonly onDone: (projectRef?: ScopedProjectRef) => Promise<boolean>;
}) {
  const [source, setSource] = useState<ImportSource | null>(null);
  const [landingProject, setLandingProject] = useState<ScopedProjectRef>();
  const [isFinishing, setIsFinishing] = useState(false);
  const busy = isImporting || isFinishing;
  const returnFromHistory = useCallback(
    async (projectRef?: ScopedProjectRef) => {
      if (projectRef) setLandingProject(projectRef);
      setIsImporting(false);
      setSource(null);
      return true;
    },
    [setIsImporting],
  );
  const finish = async () => {
    if (busy) return;
    setIsFinishing(true);
    try {
      await onDone(landingProject);
    } finally {
      setIsFinishing(false);
    }
  };

  if (source === null) {
    return (
      <ImportSourcePicker disabled={busy} onSelect={setSource} onContinue={() => void finish()} />
    );
  }

  return (
    <>
      <ImportSourceHeader source={source} disabled={busy} onBack={() => setSource(null)} />
      {source === "t3-code" ? (
        <>
          <div className="mt-5">
            <DataImportPanel environmentIds={environmentIds} embedded />
          </div>
          <div className="mt-6 flex justify-end">
            <Button disabled={busy} onClick={() => setSource(null)}>
              Back to import options
            </Button>
          </div>
        </>
      ) : (
        <HistoryImportStep
          environmentIds={environmentIds}
          isImporting={isImporting}
          setIsImporting={setIsImporting}
          onDone={returnFromHistory}
        />
      )}
    </>
  );
}
