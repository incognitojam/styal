import {
  STYAL_PROJECT_FILE_NAME,
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectConfig,
} from "@t3tools/contracts";
import { resolveProjectConfig } from "@t3tools/shared/projectFile";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { createContext, type ReactNode, useContext } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { getProjectFileQueryAtom, optimisticFileAtom } from "../files/projectFilesQueryState";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { resolveScopedSettingsTargets, selectScopedSettingsEnvironments } from "./scopedSettings";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import { selectSingleEnvironmentScope } from "./settingsScopeAxis";

/**
 * Each member's project configuration (styal.json, or a legacy t3.json), so
 * file-backed settings show the file as a layer in the inheritance chain. A
 * member is only present once both reads have settled; the query atoms
 * cache per (environment, cwd).
 */
function useMemberProjectFiles(scope: ReturnType<typeof resolveSettingsScope>) {
  const members = scope.kind === "project" || scope.kind === "checkout" ? scope.members : [];
  return useAtomValue(
    Atom.make((get) => {
      // Contents of one root file, null when missing or truncated, or
      // undefined while its read is still waiting.
      const readContents = (
        environmentId: EnvironmentId,
        workspaceRoot: string,
        relativePath: string,
      ): string | null | undefined => {
        const result = get(getProjectFileQueryAtom(environmentId, workspaceRoot, relativePath));
        if (result.waiting) return undefined;
        const data =
          get(optimisticFileAtom(environmentId, workspaceRoot, relativePath))?.data ??
          Option.getOrNull(AsyncResult.value(result));
        return data === null || data.truncated ? null : data.contents;
      };
      const files = new Map<string, ProjectConfig | null>();
      for (const member of members) {
        const styal = readContents(
          member.environmentId,
          member.workspaceRoot,
          STYAL_PROJECT_FILE_NAME,
        );
        const t3 = readContents(member.environmentId, member.workspaceRoot, T3_PROJECT_FILE_NAME);
        if (styal === undefined || t3 === undefined) continue;
        files.set(member.physicalProjectKey, resolveProjectConfig({ styal, t3 }).config);
      }
      return files;
    }),
  );
}

function useResolvedSettingsScope(rawSearch: SettingsScopeSearch, singleEnvironment: boolean) {
  const groups = useSettingsProjectGroups();
  const { environments: availableEnvironments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const search = singleEnvironment
    ? selectSingleEnvironmentScope(
        rawSearch,
        resolveSettingsScope(rawSearch, groups, availableEnvironments),
        availableEnvironments,
        primaryEnvironmentId,
      )
    : rawSearch;
  const scope = resolveSettingsScope(search, groups, availableEnvironments);
  const projectFiles = useMemberProjectFiles(scope);
  const selected = selectScopedSettingsEnvironments(
    scope,
    availableEnvironments,
    primaryEnvironmentId,
  );
  const targets = resolveScopedSettingsTargets(scope, selected.connectedEnvironments, projectFiles);
  const target =
    targets.find((candidate) => candidate.environmentId === selected.environment?.environmentId) ??
    targets[0] ??
    null;
  return { scope, groups, search, ...selected, targets, target, projectFiles };
}

const SettingsScopeContext = createContext<
  | (ReturnType<typeof useResolvedSettingsScope> & {
      singleEnvironment: boolean;
      search: SettingsScopeSearch;
      selectScope: (next: SettingsScopeSearch) => void;
    })
  | null
>(null);

export function SettingsScopeProvider({
  search,
  onChange,
  children,
  singleEnvironment = false,
}: {
  singleEnvironment?: boolean;
  search: SettingsScopeSearch;
  onChange: (next: SettingsScopeSearch) => void;
  children: ReactNode;
}) {
  const resolved = useResolvedSettingsScope(search, singleEnvironment);
  const value = { ...resolved, singleEnvironment, selectScope: onChange };
  return <SettingsScopeContext value={value}>{children}</SettingsScopeContext>;
}

export function useOptionalSettingsScope() {
  return useContext(SettingsScopeContext);
}

export function useSettingsScope() {
  const scope = useOptionalSettingsScope();
  if (scope === null) throw new Error("Settings scope must be read inside SettingsScopeProvider.");
  return scope;
}
