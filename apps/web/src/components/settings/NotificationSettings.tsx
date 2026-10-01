import { useState } from "react";
import { DEFAULT_CLIENT_SETTINGS, type NotificationSound } from "@t3tools/contracts/settings";

import {
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  NOTIFICATION_SOUND_LABELS,
  playNotificationSound,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
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

  async function changeMode(value: string | null) {
    if (
      value !== "off" &&
      value !== "notifications" &&
      value !== "sound" &&
      value !== "notifications-and-sound"
    )
      return;
    setPermissionMessage(null);
    if (hasNotificationSound(value)) void unlockNotificationAudio();
    if (hasDesktopNotifications(value)) {
      if (typeof Notification === "undefined" || !window.isSecureContext) {
        setPermissionMessage(
          "Notifications need a supported browser over HTTPS, or the desktop app. Sound only is still available.",
        );
        return;
      }
      setRequesting(true);
      try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          setPermissionMessage(
            "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.",
          );
          return;
        }
      } catch {
        setPermissionMessage(
          "Notifications are unavailable in this browser. Sound only is still available.",
        );
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
      description={
        permissionMessage ??
        (needsPermission
          ? "System notifications need permission on this device. Sound follows your selected mode."
          : "System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while styal is open.")
      }
      control={
        <>
          <Select value={mode} disabled={requesting} onValueChange={changeMode}>
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Thread notifications">
              <SelectValue>{NOTIFICATION_MODE_LABELS[mode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
                <SelectItem key={value} hideIndicator value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {needsPermission ? (
            <Button variant="outline" disabled={requesting} onClick={() => void changeMode(mode)}>
              Allow notifications
            </Button>
          ) : null}
        </>
      }
    >
      <SettingsSubRows>
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
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Preview ${label.toLowerCase()}`}
                  disabled={!soundEnabled || settings[key] === "none"}
                  onClick={async () => {
                    await unlockNotificationAudio();
                    await playNotificationSound(kind, () => true, settings[key]);
                  }}
                >
                  Preview
                </Button>
              </>
            }
          />
        ))}
      </SettingsSubRows>
    </SettingsRow>
  );
}
