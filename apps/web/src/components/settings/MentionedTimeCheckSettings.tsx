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
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow } from "./settingsLayout";
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
    <>
      <SettingsRow
        serverScoped
        settingKeys={["mentionedTimeCheckEnabled"]}
        mixed={mixedTimeCheckEnabled}
        {...searchableSetting("mentioned-time-check")}
        forkFeature="mentioned-time-chips"
        description="When an agent's reply mentions a clock time, a model reads the whole reply to tell times of day from lengths and examples, and to work out which day it means. Time chips then follow its reading. Each reply with a clock time costs one short model call."
        control={
          <Switch
            mixed={mixedTimeCheckEnabled}
            checked={mixedTimeCheckEnabled ? false : settings.mentionedTimeCheckEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ mentionedTimeCheckEnabled: Boolean(checked) })
            }
            aria-label="Check mentioned times with a model"
          />
        }
      />

      {settings.mentionedTimeCheckEnabled || mixedTimeCheckEnabled ? (
        <SettingsRow
          serverScoped
          settingKeys={["mentionedTimeCheckModelSelection"]}
          {...searchableSetting("mentioned-time-check-model")}
          description="Model that checks mentioned times. A small, fast model is enough; reasoning does not help. Off uses GPT-6.1 Terra or Claude Haiku when either is available, otherwise the text generation model."
          control={
            !hasServerTargets ? (
              <span className="text-sm text-muted-foreground">
                Connect an environment to choose its time check model.
              </span>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {usesTimeCheckModel || mixedTimeCheckModel ? (
                  <ProviderModelPicker
                    environmentId={environmentId}
                    activeInstanceId={timeCheckSelection.instanceId}
                    model={timeCheckSelection.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={timeCheckModelOptionsByInstance}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    triggerAriaLabel="Time check model"
                    {...(mixedTimeCheckModel ? { triggerLabel: "Mixed" } : {})}
                    getModelDisabledReason={writerModelDisabledReason}
                    onInstanceModelChange={(instanceId, model) =>
                      saveTimeCheckModel(createModelSelection(instanceId, model))
                    }
                  />
                ) : null}
                {usesTimeCheckModel && !mixedTimeCheckModel && timeCheckInstanceEntry ? (
                  <TraitsPicker
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
                <Switch
                  mixed={mixedTimeCheckModel}
                  checked={mixedTimeCheckModel ? false : usesTimeCheckModel}
                  onCheckedChange={(checked) => {
                    if (!checked) {
                      updateSettings({ mentionedTimeCheckModelSelection: null });
                      return;
                    }
                    saveTimeCheckModel(
                      createModelSelection(
                        timeCheckSelection.instanceId,
                        timeCheckSelection.model,
                        timeCheckSelection.options,
                      ),
                    );
                  }}
                  aria-label="Use a separate time check model"
                />
              </div>
            )
          }
        />
      ) : null}
    </>
  );
}
