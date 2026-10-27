import { AuthSettingsWriteScope, SIMULATOR_MEMORY_DESCRIPTION } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Pressable } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "./settings-scoped-server";
import { useSettingsWriter } from "./useSettingsWriter";

export function SimulatorMemorySettings() {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const project = projectGroups.find((group) => group.key === selectedProjectKey);
  const projectSelected = selectedProjectKey !== null;
  const targets = resolveMobileSettingsTargets(
    selectedTargets,
    projectSelected ? (project?.members.map((member) => member.project) ?? []) : null,
  );
  const writable = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const [pending, setPending] = useState(false);
  const writing = useRef(false);
  const write = useSettingsWriter();
  const mode = uniformMobileSetting(targets, "simulatorMemoryMode");
  const disabled =
    pending ||
    targets.length === 0 ||
    targets.some((target) => !writable.has(target.environment.environmentId));
  return (
    <SettingsSection title="Simulator startup" footer={SIMULATOR_MEMORY_DESCRIPTION}>
      <ListRowLayout
        icon={{ ios: "memorychip", android: "smartphone" }}
        label="Simulator memory"
        disabled={disabled}
        accessory={
          <Menu
            actions={[
              ...(projectSelected ? [{ id: "inherit", title: "Use environment default" }] : []),
              {
                id: "standard",
                title: "Standard",
                state: mode === "standard" ? ("on" as const) : ("off" as const),
              },
              {
                id: "low-memory",
                title: "Low memory",
                state: mode === "low-memory" ? ("on" as const) : ("off" as const),
              },
            ]}
            onPressAction={({ nativeEvent }) => {
              const value = nativeEvent.event;
              if (
                writing.current ||
                disabled ||
                targets.some(
                  (target) =>
                    !readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
                )
              )
                return;
              const writes =
                value === "inherit"
                  ? planMobileScopedSettingsClear(targets, ["simulatorMemoryMode"])
                  : value === "standard" || value === "low-memory"
                    ? planMobileScopedSettingsPatch(targets, projectSelected, {
                        simulatorMemoryMode: value,
                      })
                    : [];
              if (writes.length === 0) return;
              writing.current = true;
              setPending(true);
              void write(targets, writes).finally(() => {
                writing.current = false;
                setPending(false);
              });
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Simulator memory"
              disabled={disabled}
            >
              <AppText className="text-base text-foreground-muted">
                {mode === null ? "Mixed" : mode === "low-memory" ? "Low memory" : "Standard"}
              </AppText>
            </Pressable>
          </Menu>
        }
      />
    </SettingsSection>
  );
}
