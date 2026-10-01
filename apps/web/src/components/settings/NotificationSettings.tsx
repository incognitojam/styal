import { Volume2Icon } from "lucide-react";
import { useState } from "react";
import {
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  type NotificationSound,
} from "@t3tools/contracts/settings";

import {
  hasDesktopNotifications,
  hasNotificationSound,
  notificationModeFor,
  NOTIFICATION_SOUND_LABELS,
  playNotificationSound,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSubRow, SettingsSubRows, SettingResetButton } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const SOUND_SETTINGS = [
  { key: "completionSound", id: "completion-sound", label: "Completion sound", kind: "completion" },
  { key: "inputSound", id: "input-sound", label: "Input sound", kind: "input" },
  { key: "approvalSound", id: "approval-sound", label: "Approval sound", kind: "input" },
] as const;

function isNotificationSound(value: string | null): value is NotificationSound {
  return (
    value === "t3-completion" || value === "t3-input" || value === "avanti" || value === "none"
  );
}

export function NotificationSettings() {
  const settings = useScopedSettings();
  const mode = settings.notificationMode;
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const soundEnabled = hasNotificationSound(mode);
  const needsPermission =
    hasDesktopNotifications(mode) &&
    (typeof Notification === "undefined" || Notification.permission !== "granted");

  async function changeMode(value: ClientSettings["notificationMode"]) {
    setPermissionMessage(null);
    if (hasNotificationSound(value)) void unlockNotificationAudio();
    if (hasDesktopNotifications(value)) {
      if (typeof Notification === "undefined" || !window.isSecureContext) {
        setPermissionMessage("Needs a supported browser over HTTPS, or the desktop app.");
        return;
      }
      setRequesting(true);
      try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          setPermissionMessage(
            "Allow notifications in your browser or system settings, then turn this on again.",
          );
          return;
        }
      } catch {
        setPermissionMessage("Notifications are unavailable in this browser.");
        return;
      } finally {
        setRequesting(false);
      }
    }
    updateSettings({ notificationMode: value });
  }

  return (
    <SettingsRow
      {...searchableSetting("thread-notifications")}
      description="Alerts when a thread finishes, fails, or needs input or approval. Applies to this device while styal is open."
    >
      <SettingsSubRows>
        <SettingsSubRow
          {...searchableSetting("system-notifications")}
          title="System notifications"
          description={
            permissionMessage ?? (needsPermission ? "Needs permission on this device." : undefined)
          }
          control={
            <>
              {needsPermission ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={requesting}
                  onClick={() => void changeMode(mode)}
                >
                  Allow notifications
                </Button>
              ) : null}
              <Switch
                checked={hasDesktopNotifications(mode)}
                disabled={requesting}
                onCheckedChange={(checked) =>
                  void changeMode(notificationModeFor(checked, soundEnabled))
                }
                aria-label="System notifications"
              />
            </>
          }
        />
        <SettingsSubRow
          {...searchableSetting("in-app-notifications")}
          title="In-app toasts"
          description="Shown for other threads while styal has focus."
          control={
            <Switch
              checked={settings.inAppNotificationsEnabled}
              onCheckedChange={(checked) => updateSettings({ inAppNotificationsEnabled: checked })}
              aria-label="In-app toasts"
            />
          }
        />
        <SettingsSubRow
          {...searchableSetting("notification-sounds")}
          title="Sounds"
          control={
            <Switch
              checked={soundEnabled}
              onCheckedChange={(checked) =>
                void changeMode(notificationModeFor(hasDesktopNotifications(mode), checked))
              }
              aria-label="Notification sounds"
            />
          }
        />
        {SOUND_SETTINGS.map(({ key, id, label, kind }) => (
          <SettingsSubRow
            key={key}
            {...searchableSetting(id)}
            disabled={!soundEnabled}
            resetAction={
              settings[key] !== DEFAULT_CLIENT_SETTINGS[key] ? (
                <SettingResetButton
                  label={label.toLowerCase()}
                  disabled={!soundEnabled}
                  onClick={() => updateSettings({ [key]: DEFAULT_CLIENT_SETTINGS[key] })}
                />
              ) : null
            }
            control={
              <>
                <Select
                  value={settings[key]}
                  disabled={!soundEnabled}
                  onValueChange={(value) => {
                    if (isNotificationSound(value)) updateSettings({ [key]: value });
                  }}
                >
                  <SelectTrigger size="sm" className="w-40" aria-label={label}>
                    <SelectValue>{NOTIFICATION_SOUND_LABELS[settings[key]]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {Object.entries(NOTIFICATION_SOUND_LABELS).map(([value, soundLabel]) => (
                      <SelectItem key={value} hideIndicator value={value}>
                        {soundLabel}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost-muted"
                        size="icon-sm"
                        aria-label={`Preview ${label.toLowerCase()}`}
                        disabled={!soundEnabled || settings[key] === "none"}
                        onClick={async () => {
                          await unlockNotificationAudio();
                          await playNotificationSound(kind, () => true, settings[key]);
                        }}
                      >
                        <Volume2Icon />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">Preview</TooltipPopup>
                </Tooltip>
              </>
            }
          />
        ))}
      </SettingsSubRows>
    </SettingsRow>
  );
}
