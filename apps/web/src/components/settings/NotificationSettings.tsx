import { msg, useGT, useMessages } from "gt-react";
import { Volume2Icon } from "lucide-react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
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
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { SettingsSubRow, SettingsSubRows } from "./NotificationSubRows";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const SOUND_SETTINGS = [
  {
    key: "completionSound",
    id: "completion-sound",
    label: msg("Completion sound"),
    kind: "completion",
  },
  { key: "inputSound", id: "input-sound", label: msg("Input sound"), kind: "input" },
  { key: "approvalSound", id: "approval-sound", label: msg("Approval sound"), kind: "input" },
] as const;

function isNotificationSound(value: string | null): value is NotificationSound {
  return value !== null && Object.hasOwn(NOTIFICATION_SOUND_LABELS, value);
}

export function NotificationSettings() {
  const gt = useGT();
  const m = useMessages();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const mode = settings.notificationMode;
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const soundEnabled = hasNotificationSound(mode);
  const needsPermission =
    hasDesktopNotifications(mode) &&
    (typeof Notification === "undefined" || Notification.permission !== "granted");

  async function changeMode(value: ClientSettings["notificationMode"], requestPermission = false) {
    setPermissionMessage(null);
    if (hasNotificationSound(value)) void unlockNotificationAudio();
    if (requestPermission) {
      if (typeof Notification === "undefined" || !window.isSecureContext) {
        setPermissionMessage(gt("Needs a supported browser over HTTPS, or the desktop app."));
        return;
      }
      setRequesting(true);
      const permission = await settlePromise(() => Notification.requestPermission());
      setRequesting(false);
      if (permission._tag === "Failure") {
        setPermissionMessage(gt("Notifications are unavailable in this browser."));
        return;
      }
      if (permission.value !== "granted") {
        setPermissionMessage(
          gt("Allow notifications in your browser or system settings, then turn this on again."),
        );
        return;
      }
    }
    updateSettings({ notificationMode: value });
  }

  return (
    <>
      <SettingsRow
        {...searchableSetting("thread-notifications")}
        description={gt(
          "Alerts on this device when a thread finishes, fails, or needs input or approval.",
        )}
      >
        <SettingsSubRows>
          <SettingsSubRow
            id="system-notifications"
            title={gt("System notifications")}
            description={
              permissionMessage ??
              (needsPermission
                ? gt("Needs permission on this device.")
                : gt("Shown while styal is open, including in the background."))
            }
            control={
              <>
                {needsPermission ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={requesting}
                    onClick={() => void changeMode(mode, true)}
                  >
                    {gt("Allow notifications")}
                  </Button>
                ) : null}
                <Switch
                  checked={hasDesktopNotifications(mode)}
                  disabled={requesting}
                  onCheckedChange={(checked) =>
                    void changeMode(notificationModeFor(checked, soundEnabled), checked)
                  }
                  aria-label={gt("System notifications")}
                />
              </>
            }
          />
          <SettingsSubRow
            {...searchableSetting("in-app-notifications")}
            title={gt("In-app notifications")}
            description={gt(
              "Show a toast when another thread finishes, fails, or needs input or approval while this app has focus.",
            )}
            control={
              <Switch
                checked={settings.inAppNotificationsEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({ inAppNotificationsEnabled: checked })
                }
                aria-label={gt("In-app notifications")}
              />
            }
          />
        </SettingsSubRows>
      </SettingsRow>
      <SettingsRow
        id="notification-sounds"
        title={gt("Notification sounds")}
        description={gt("Plays for every thread while styal is open, including in the background.")}
        control={
          <Switch
            checked={soundEnabled}
            onCheckedChange={(checked) =>
              void changeMode(notificationModeFor(hasDesktopNotifications(mode), checked))
            }
            aria-label={gt("Notification sounds")}
          />
        }
      >
        <SettingsSubRows>
          {SOUND_SETTINGS.map(({ key, id, label, kind }) => (
            <SettingsSubRow
              key={key}
              id={id}
              title={m(label)}
              disabled={!soundEnabled}
              resetAction={
                settings[key] !== DEFAULT_CLIENT_SETTINGS[key] ? (
                  <SettingResetButton
                    ariaLabel={gt("Reset {title} to default", { title: m(label).toLowerCase() })}
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
                    <SelectTrigger size="sm" className="w-40" aria-label={m(label)}>
                      <SelectValue>{m(NOTIFICATION_SOUND_LABELS[settings[key]])}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {Object.entries(NOTIFICATION_SOUND_LABELS).map(([value, soundLabel]) => (
                        <SelectItem key={value} hideIndicator value={value}>
                          {m(soundLabel)}
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
                          aria-label={gt("Preview {title}", { title: m(label).toLowerCase() })}
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
                    <TooltipPopup side="top">{gt("Preview")}</TooltipPopup>
                  </Tooltip>
                </>
              }
            />
          ))}
        </SettingsSubRows>
      </SettingsRow>
    </>
  );
}
