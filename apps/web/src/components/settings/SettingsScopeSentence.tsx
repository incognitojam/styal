import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, LayersIcon, Settings2Icon } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  useEnvironments,
  useRelayEnvironmentDiscovery,
  type EnvironmentPresentation,
} from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import {
  ALL_ENVIRONMENTS_VALUE,
  ALL_PROJECTS_VALUE,
  environmentAxisValue,
  projectAxisValue,
  projectScopeMenuGroups,
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeEnvironmentLabel,
  settingsScopeEnvironmentLabels,
  settingsScopeProjectMachines,
} from "./settingsScopeAxis";

/**
 * Pages whose every row is saved on this client, plus the import page, which
 * picks its own destination environment. Browser and Devices list their environments
 * explicitly. These pages have no scope to pick.
 */
export const SETTINGS_DEVICE_ONLY_PATHS: ReadonlySet<string> = new Set([
  "/settings/general",
  "/settings/appearance",
  "/settings/chat",
  "/settings/diffs",
  "/settings/snap-shot",
  "/settings/connections",
  "/settings/import",
  "/settings/browser",
  "/settings/devices",
  // Network access and authorized clients belong to the environment serving this app.
  "/settings/access",
  "/settings/about",
]);

interface SettingsScopeMenuProps {
  readonly value: SettingsScopeSearch;
  readonly groups: readonly SidebarProjectSnapshot[];
  readonly environments: readonly EnvironmentPresentation[];
  readonly singleEnvironment: boolean;
  readonly onChange: (next: SettingsScopeSearch) => void;
}

/**
 * The pickers are the targets a change is written to. A project is the same on every
 * environment, so the environment alone decides where a project override is written.
 */
export function SettingsScopeSentence({ compact = false }: { compact?: boolean }) {
  const scope = useOptionalSettingsScope();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { environments } = useEnvironments();
  if (scope === null || SETTINGS_DEVICE_ONLY_PATHS.has(pathname)) return null;
  const props: SettingsScopeMenuProps = {
    value: scope.search,
    singleEnvironment: scope.singleEnvironment,
    groups: scope.groups,
    environments,
    onChange: scope.selectScope,
  };
  return (
    <p
      className={
        compact
          ? "flex min-w-0 items-center gap-3 text-sm text-muted-foreground"
          : "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 px-3 text-sm text-muted-foreground sm:px-4"
      }
    >
      {scope.singleEnvironment ? null : (
        <span className="flex min-w-0 items-center gap-1.5">
          {compact ? null : <span className="shrink-0">Applying settings for</span>}
          <ProjectScopeMenu {...props} />
        </span>
      )}
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={compact ? "hidden" : "shrink-0"}>
          {scope.singleEnvironment
            ? "Applying settings on"
            : scope.search.machine || scope.scope.kind === "checkout"
              ? "on"
              : "across"}
        </span>
        <EnvironmentScopeMenu {...props} />
      </span>
    </p>
  );
}

interface ScopeOption {
  value: string;
  label: string;
  secondary?: string;
  icon?: ReactNode;
  offline?: boolean;
}

function ScopeOptionLabel({ option }: { option: ScopeOption }) {
  return (
    <>
      {option.icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{option.label}</span>
        {option.secondary ? (
          <span className="block truncate text-xs text-muted-foreground">{option.secondary}</span>
        ) : null}
      </span>
      {option.offline ? (
        <span className="shrink-0 text-xs text-muted-foreground">Offline</span>
      ) : null}
    </>
  );
}

const FOOTER_VALUE = "settings-scope-footer";

function ScopeMenu({
  ariaLabel,
  icon,
  label,
  value,
  options,
  allOption,
  footer,
  searchLabel,
  onChange,
}: {
  ariaLabel: string;
  icon: ReactNode;
  label: string;
  value: string;
  options: ScopeOption[];
  allOption: ScopeOption | null;
  /** A last entry that goes somewhere instead of choosing a scope. */
  footer?: { option: ScopeOption; onSelect: () => void };
  searchLabel: string;
  onChange: (next: string) => void;
}) {
  const [query, setQuery] = useState("");
  const Trigger = options.length > 6 ? ComboboxTrigger : MenuTrigger;
  const trigger = (
    <Trigger
      aria-label={`${ariaLabel}: ${label}`}
      render={<Button variant="outline" size="sm" />}
      className="min-w-0 max-w-72 shrink"
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDownIcon
        aria-hidden
        strokeWidth={1.75}
        className="-me-0.5 size-3.5 shrink-0 text-muted-foreground opacity-70"
      />
    </Trigger>
  );
  const choices = allOption ? [allOption, ...options] : options;
  if (options.length > 6) {
    const needle = query.trim().toLowerCase();
    const matches = choices.filter((option) =>
      `${option.label} ${option.secondary ?? ""} ${option.value}`.toLowerCase().includes(needle),
    );
    const footerOption = footer ? { ...footer.option, value: FOOTER_VALUE } : null;
    const filteredItems = footerOption ? [...matches, footerOption] : matches;
    return (
      <Combobox
        items={footerOption ? [...choices, footerOption] : choices}
        filteredItems={filteredItems}
        filter={null}
        autoHighlight
        itemToStringLabel={(option) => option.label}
        isItemEqualToValue={(a, b) => a.value === b.value}
        value={choices.find((option) => option.value === value) ?? null}
        onOpenChange={(open) => {
          if (!open) setQuery("");
        }}
        onValueChange={(option) => {
          if (option?.value === FOOTER_VALUE) footer?.onSelect();
          else if (option) onChange(option.value);
        }}
      >
        {trigger}
        <ComboboxPopup align="start" className="w-80">
          <ComboboxSearchInput
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ComboboxEmpty>No matches found.</ComboboxEmpty>
          <ComboboxList>
            {(option: ScopeOption) => (
              <ComboboxItem key={option.value} value={option}>
                <ScopeOptionLabel option={option} />
                {option.value === value ? (
                  <CheckIcon aria-hidden className="size-3.5 shrink-0" />
                ) : null}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    );
  }
  return (
    <Menu>
      {trigger}
      <MenuPopup align="start">
        <div className="w-72 max-w-full">
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              if (typeof next === "string") onChange(next);
            }}
          >
            {choices.map((option, index) => (
              <Fragment key={option.value}>
                <MenuRadioItem value={option.value} closeOnClick>
                  <span className="flex min-w-0 items-center gap-2">
                    <ScopeOptionLabel option={option} />
                    <MenuRadioItemIndicator />
                  </span>
                </MenuRadioItem>
                {index === 0 && allOption ? <MenuSeparator /> : null}
              </Fragment>
            ))}
          </MenuRadioGroup>
          {footer ? (
            <>
              <MenuSeparator />
              <MenuItem onClick={footer.onSelect}>
                <ScopeOptionLabel option={footer.option} />
              </MenuItem>
            </>
          ) : null}
        </div>
      </MenuPopup>
    </Menu>
  );
}

function EnvironmentScopeMenu({
  value,
  groups,
  environments,
  onChange,
  singleEnvironment,
}: SettingsScopeMenuProps) {
  const resolved = resolveSettingsScope(value, groups, environments);
  const environmentValue = environmentAxisValue(
    value,
    resolved.kind === "checkout" ? resolved.environmentId : null,
  );
  const selected = environments.find(
    (environment) => environment.environmentId === environmentValue,
  );
  const project = groups.find((group) => group.projectKey === value.project);
  const memberEnvironmentIds = project
    ? new Set(project.memberProjects.map((member) => member.environmentId))
    : null;
  const options = memberEnvironmentIds
    ? environments.filter((environment) => memberEnvironmentIds.has(environment.environmentId))
    : environments;
  const navigate = useNavigate();
  const discovery = useRelayEnvironmentDiscovery();
  const notAdded = [...discovery.environments.values()]
    .map((entry) => entry.environment)
    .filter(
      (entry) =>
        !environments.some((environment) => environment.environmentId === entry.environmentId),
    );
  return (
    <ScopeMenu
      ariaLabel="Environment scope"
      icon={
        selected ? (
          <EnvironmentMachineIcon
            aria-hidden
            kind={resolveEnvironmentMachineKind(selected.serverConfig)}
            className="size-3.5 shrink-0"
          />
        ) : null
      }
      label={
        selected
          ? settingsScopeEnvironmentLabel(selected, environments)
          : environmentValue !== ALL_ENVIRONMENTS_VALUE
            ? "Unavailable environment"
            : singleEnvironment
              ? "No environments"
              : "All environments"
      }
      value={environmentValue}
      onChange={(next) => onChange(selectEnvironmentAxis(value, next))}
      searchLabel="Search environments"
      footer={{
        option: {
          value: FOOTER_VALUE,
          label: singleEnvironment ? "Add a machine…" : "Manage machines…",
          secondary:
            notAdded.length === 1
              ? `${notAdded[0]!.label} isn't added yet`
              : notAdded.length > 1
                ? `${notAdded.length} machines aren't added yet`
                : "",
          icon: <Settings2Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />,
        },
        onSelect: () => void navigate({ to: "/settings/connections" }),
      }}
      allOption={
        singleEnvironment
          ? null
          : {
              value: ALL_ENVIRONMENTS_VALUE,
              label: "All environments",
              icon: <LayersIcon aria-hidden className="size-3.5 shrink-0" />,
            }
      }
      options={options.map((environment) => {
        const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
        return {
          value: environment.environmentId,
          label: primary,
          secondary,
          icon: (
            <EnvironmentMachineIcon
              aria-hidden
              kind={resolveEnvironmentMachineKind(environment.serverConfig)}
              className="size-3.5 shrink-0"
            />
          ),
          offline: environment.connection.phase !== "connected",
        };
      })}
    />
  );
}

function ProjectScopeMenu({ value, groups, environments, onChange }: SettingsScopeMenuProps) {
  const selected = groups.find((group) => group.projectKey === value.project);
  const projects = projectScopeMenuGroups(groups, value).map((group) => ({
    group,
    machines: settingsScopeProjectMachines(group, environments).join(", "),
  }));
  return (
    <ScopeMenu
      ariaLabel="Project scope"
      icon={selected ? <ProjectFavicon project={selected} className="size-3.5 shrink-0" /> : null}
      label={selected?.displayName ?? (value.project ? "Unavailable project" : "All projects")}
      value={projectAxisValue(value)}
      onChange={(next) => onChange(selectProjectAxis(value, next))}
      searchLabel="Search projects"
      allOption={{ value: ALL_PROJECTS_VALUE, label: "All projects" }}
      options={projects.map(({ group, machines }) => {
        const sameName = projects.filter(
          (other) =>
            other.group.projectKey !== group.projectKey &&
            other.group.displayName === group.displayName,
        );
        const location =
          sameName.length === 0
            ? environments.length > 1
              ? group.workspaceRoot
              : ""
            : sameName.some((other) => other.machines === machines)
              ? `${machines} · ${group.workspaceRoot}`
              : machines;
        return {
          value: group.projectKey,
          label: group.displayName,
          secondary: group.archived ? ["Archived", location].filter(Boolean).join(" · ") : location,
          icon: <ProjectFavicon project={group} className="size-3.5 shrink-0" />,
        };
      })}
    />
  );
}
