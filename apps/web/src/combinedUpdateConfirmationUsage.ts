import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { reportForkClientUsage } from "./forkClientUsage";
import { useForkUsageEnvironmentId } from "./forkUsageEnvironment";

/** One exposure and one explicit decision per opening, kept on the same paired environment. */
export function useCombinedUpdateConfirmationUsage(open: boolean) {
  const environmentId = useForkUsageEnvironmentId();
  const exposure = useRef<{ environmentId: EnvironmentId; decided: boolean } | null>(null);

  useEffect(() => {
    if (!open) {
      exposure.current = null;
      return;
    }
    if (exposure.current || !environmentId) return;
    exposure.current = { environmentId, decided: false };
    void reportForkClientUsage(environmentId, {
      feature: "combined-update-confirmation",
      action: "shown",
    });
  }, [environmentId, open]);

  return (action: "confirmed" | "cancelled") => {
    const current = exposure.current;
    if (!current || current.decided) return;
    current.decided = true;
    void reportForkClientUsage(current.environmentId, {
      feature: "combined-update-confirmation",
      action,
    });
  };
}
