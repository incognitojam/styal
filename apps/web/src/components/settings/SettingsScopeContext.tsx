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

type ProjectFileMember = readonly [
  environmentId: EnvironmentId,
  workspaceRoot: string,
  physicalProjectKey: string,
];

// A member is present only once both reads (styal.json and legacy t3.json) have settled.
const memberProjectFilesAtom = Atom.family((membersKey: string) => {
  const members = JSON.parse(membersKey) as ReadonlyArray<ProjectFileMember>;
  return Atom.make((get) => {
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
      return data === null || data.exists === false || data.truncated ? null : data.contents;
    };
    const files = new Map<string, ProjectConfig | null>();
    for (const [environmentId, workspaceRoot, physicalProjectKey] of members) {
      const styal = readContents(environmentId, workspaceRoot, STYAL_PROJECT_FILE_NAME);
      const t3 = readContents(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME);
      if (styal === undefined || t3 === undefined) continue;
      files.set(physicalProjectKey, resolveProjectConfig({ styal, t3 }).config);
    }
    return files;
  }).pipe(Atom.withLabel(`web-settings-member-project-files:${membersKey}`));
});

function useMemberProjectFiles(scope: ReturnType<typeof resolveSettingsScope>) {
  const members = scope.kind === "project" || scope.kind === "checkout" ? scope.members : [];
  return useAtomValue(
    memberProjectFilesAtom(
      JSON.stringify(
        members.map((member): ProjectFileMember => [
          member.environmentId,
          member.workspaceRoot,
          member.physicalProjectKey,
        ]),
      ),
    ),
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

/** Reuse the page's project inventory while controls target one explicit environment. */
export function SettingsEnvironmentScope({
  environmentId,
  onChange,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly onChange: (next: SettingsScopeSearch) => void;
  readonly children: ReactNode;
}) {
  const parent = useSettingsScope();
  const search = { machine: environmentId };
  const scope = resolveSettingsScope(search, parent.groups, parent.environments);
  const selected = selectScopedSettingsEnvironments(scope, parent.environments, environmentId);
  const targets = resolveScopedSettingsTargets(scope, selected.connectedEnvironments);
  return (
    <SettingsScopeContext
      value={{
        ...parent,
        ...selected,
        scope,
        search,
        targets,
        target: targets[0] ?? null,
        singleEnvironment: true,
        selectScope: onChange,
      }}
    >
      {children}
    </SettingsScopeContext>
  );
}
