import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { reportForkClientUsage, supportsForkClientUsage } from "./forkClientUsage";
import { useServerConfigs } from "./state/entities";
import { primaryEnvironmentIdAtom } from "./state/primaryEnvironment";

/** One exposure and one explicit decision per opening, kept on the same paired environment. */
export function useCombinedUpdateConfirmationUsage(open: boolean) {
  const primaryId = useAtomValue(primaryEnvironmentIdAtom);
  const configs = useServerConfigs();
  const environmentId =
    primaryId && supportsForkClientUsage(configs.get(primaryId))
      ? primaryId
      : ([...configs].find(([, config]) => supportsForkClientUsage(config))?.[0] ?? null);
  const session = useRef<{
    environmentId: EnvironmentId | null;
    decided: boolean;
  } | null>(null);

  useEffect(() => {
    if (!open) {
      session.current = null;
      return;
    }
    if (session.current === null) session.current = { environmentId: null, decided: false };
    const current = session.current;
    if (!environmentId || current.environmentId || current.decided) return;
    current.environmentId = environmentId;
    void reportForkClientUsage(environmentId, {
      feature: "combined-update-confirmation",
      action: "shown",
    });
  }, [environmentId, open]);

  return (action: "confirmed" | "cancelled") => {
    const current = session.current;
    if (!open || !current || current.decided) return;
    current.decided = true;
    void reportForkClientUsage(current.environmentId ?? environmentId, {
      feature: "combined-update-confirmation",
      action,
    });
  };
}
