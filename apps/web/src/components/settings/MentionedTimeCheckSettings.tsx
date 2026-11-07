import { createModelSelection } from "@t3tools/shared/model";
import { resolveMentionedTimeCheckModelSelection } from "@t3tools/shared/serverSettings";

import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function MentionedTimeCheckSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["mentionedTimeCheckEnabled"]);
  return (
    <SettingsRow
      serverScoped
      settingKeys={["mentionedTimeCheckEnabled"]}
      mixed={mixed}
      {...searchableSetting("mentioned-time-check")}
      forkFeature="mentioned-time-chips"
      description="Improve time chips using a model. Adds a short model call for replies that mention a time."
      control={
        <Switch
          mixed={mixed}
          checked={mixed ? false : settings.mentionedTimeCheckEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ mentionedTimeCheckEnabled: Boolean(checked) })
          }
          aria-label="Check mentioned times with a model"
        />
      }
    />
  );
}

export function MentionedTimeCheckModelSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, connectedEnvironments, target } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const mixedTimeCheckEnabled = useScopedSettingsMixed(["mentionedTimeCheckEnabled"]);
  const mixedTimeCheckModel = useScopedSettingsMixed(["mentionedTimeCheckModelSelection"]);
  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const instanceEntries = providerInstanceEntriesFor(
    textGenerationProviders,
    settings,
    target?.projectId ?? null,
  );
  const projectEnabledInstanceIds = new Set(
    instanceEntries
      .filter((entry) => entry.enabled && entry.isAvailable)
      .map((entry) => entry.instanceId),
  );
  const projectEffectiveTextGenerationProviders = textGenerationProviders.filter((provider) =>
    projectEnabledInstanceIds.has(provider.instanceId),
  );
  const writerModelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const usesTimeCheckModel = settings.mentionedTimeCheckModelSelection !== null;
  const timeCheckSelection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: resolveMentionedTimeCheckModelSelection(
        settings,
        textGenerationProviders,
        target?.projectId ?? null,
      ),
    },
    projectEffectiveTextGenerationProviders,
  );
  const timeCheckModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    projectEffectiveTextGenerationProviders,
    timeCheckSelection.instanceId,
    timeCheckSelection.model,
  );
  const timeCheckInstanceEntry = instanceEntries.find(
    (entry) => entry.instanceId === timeCheckSelection.instanceId,
  );
  const saveTimeCheckModel = (selection: ReturnType<typeof createModelSelection>) => {
    const reason = writerModelDisabledReason(selection.instanceId, selection.model);
    if (reason) {
      toastManager.add({ type: "error", title: "Time check model not saved", description: reason });
      return;
    }
    updateSettings({ mentionedTimeCheckModelSelection: selection });
  };

  return (
    <SettingsRow
      serverScoped
      settingKeys={["mentionedTimeCheckModelSelection"]}
      {...searchableSetting("mentioned-time-check-model")}
      mixed={mixedTimeCheckModel}
      resetAction={
        hasServerTargets && (usesTimeCheckModel || mixedTimeCheckModel) ? (
          <SettingResetButton
            label="time check model"
            onClick={() => updateSettings({ mentionedTimeCheckModelSelection: null })}
          />
        ) : null
      }
      control={
        !hasServerTargets ? (
          <span className="text-sm text-muted-foreground">
            Connect an environment to choose its time check model.
          </span>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ProviderModelPicker
              environmentId={environmentId}
              activeInstanceId={timeCheckSelection.instanceId}
              model={timeCheckSelection.model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={timeCheckModelOptionsByInstance}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              triggerAriaLabel="Time check model"
              disabled={!settings.mentionedTimeCheckEnabled && !mixedTimeCheckEnabled}
              {...(mixedTimeCheckModel ? { triggerLabel: "Mixed" } : {})}
              getModelDisabledReason={writerModelDisabledReason}
              onInstanceModelChange={(instanceId, model) =>
                saveTimeCheckModel(createModelSelection(instanceId, model))
              }
            />
            {usesTimeCheckModel && !mixedTimeCheckModel && timeCheckInstanceEntry ? (
              <TraitsPicker
                disabled={!settings.mentionedTimeCheckEnabled && !mixedTimeCheckEnabled}
                provider={timeCheckInstanceEntry.driverKind}
                models={timeCheckInstanceEntry.models}
                model={timeCheckSelection.model}
                modelOptions={timeCheckSelection.options ?? []}
                allowPromptInjectedEffort={false}
                planModeEnabled={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onModelOptionsChange={(options) =>
                  updateSettings({
                    mentionedTimeCheckModelSelection: createModelSelection(
                      timeCheckSelection.instanceId,
                      timeCheckSelection.model,
                      options,
                    ),
                  })
                }
              />
            ) : null}
          </div>
        )
      }
    />
  );
}
