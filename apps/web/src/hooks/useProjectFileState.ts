import type {
  EnvironmentId,
  ProjectScript,
  T3ProjectFile,
  T3ProjectFileScript,
  ThreadEnvMode,
} from "@t3tools/contracts";
import { useCallback } from "react";

import { useStyalProjectFileState, type StyalProjectFileState } from "./useStyalProjectFileScripts";
import { useT3ProjectFileState, type T3ProjectFileState } from "./useT3ProjectFileScripts";

const NO_LIVE_SCRIPTS: ReadonlyArray<ProjectScript> = [];
const NO_LEGACY_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];

export interface ProjectFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  source: "styal.json" | "t3.json" | null;
  defaultThreadEnvMode: ThreadEnvMode | null;
  styalContents: string | null;
  legacyFile: T3ProjectFile | null;
  liveScripts: ReadonlyArray<ProjectScript>;
  legacyScripts: ReadonlyArray<T3ProjectFileScript>;
  refresh: () => void;
}

export function resolveProjectFileState(input: {
  styal: StyalProjectFileState;
  t3: T3ProjectFileState;
  refresh: () => void;
}): ProjectFileState {
  const { styal, t3, refresh } = input;
  if (styal.status === "loading") {
    return {
      status: "loading",
      source: null,
      defaultThreadEnvMode: null,
      styalContents: null,
      legacyFile: null,
      liveScripts: NO_LIVE_SCRIPTS,
      legacyScripts: NO_LEGACY_SCRIPTS,
      refresh,
    };
  }
  if (styal.status === "valid") {
    return {
      status: "valid",
      source: "styal.json",
      defaultThreadEnvMode: styal.file?.defaultThreadEnvMode ?? null,
      styalContents: styal.contents,
      legacyFile: null,
      liveScripts: styal.scripts,
      legacyScripts: NO_LEGACY_SCRIPTS,
      refresh,
    };
  }
  if (styal.status === "invalid") {
    return {
      status: "invalid",
      source: "styal.json",
      defaultThreadEnvMode: null,
      styalContents: styal.contents,
      legacyFile: null,
      liveScripts: NO_LIVE_SCRIPTS,
      legacyScripts: NO_LEGACY_SCRIPTS,
      refresh,
    };
  }

  if (t3.status === "loading") {
    return {
      status: "loading",
      source: null,
      defaultThreadEnvMode: null,
      styalContents: null,
      legacyFile: null,
      liveScripts: NO_LIVE_SCRIPTS,
      legacyScripts: NO_LEGACY_SCRIPTS,
      refresh,
    };
  }
  if (t3.status === "valid") {
    return {
      status: "valid",
      source: "t3.json",
      defaultThreadEnvMode: t3.file?.defaultThreadEnvMode ?? null,
      styalContents: null,
      legacyFile: t3.file,
      liveScripts: NO_LIVE_SCRIPTS,
      legacyScripts: t3.scripts,
      refresh,
    };
  }
  return {
    status: t3.status,
    source: t3.status === "invalid" ? "t3.json" : null,
    defaultThreadEnvMode: null,
    styalContents: null,
    legacyFile: null,
    liveScripts: NO_LIVE_SCRIPTS,
    legacyScripts: NO_LEGACY_SCRIPTS,
    refresh,
  };
}

/**
 * Resolve project configuration for one exact checkout. styal.json owns the
 * checkout whenever it exists; only a missing file falls back to t3.json's
 * legacy import behavior.
 */
export function useProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): ProjectFileState {
  const styal = useStyalProjectFileState(environmentId, cwd);
  const t3 = useT3ProjectFileState(environmentId, styal.status === "missing" ? cwd : null);
  const refresh = useCallback(() => {
    styal.refresh();
    t3.refresh();
  }, [styal.refresh, t3.refresh]);
  return resolveProjectFileState({ styal, t3, refresh });
}
