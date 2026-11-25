import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useGT, useMessages } from "gt-react";
import type { NotificationSound } from "@t3tools/contracts/settings";
import { Volume2Icon } from "lucide-react";
import { useState } from "react";

import {
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  NOTIFICATION_SOUND_LABELS,
  playNotificationSound,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function NotificationSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
  const settings = useScopedSettings();
  const mode = settings.notificationMode;
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  return (
    <>
      <SettingsRow
        {...searchableSetting("thread-notifications")}
        description={
          permissionMessage ??
          gt(
            "System alerts when a thread finishes, fails, or needs input or approval. Applies to this device while styal is open.",
          )
        }
        control={
          <Select
            value={mode}
            disabled={requesting}
            onValueChange={async (value) => {
              if (
                value !== "off" &&
                value !== "notifications" &&
                value !== "sound" &&
                value !== "notifications-and-sound"
              )
                return;
              setPermissionMessage(null);
              if (hasNotificationSound(value)) unlockNotificationAudio();
              if (hasDesktopNotifications(value)) {
                if (typeof Notification === "undefined" || !window.isSecureContext) {
                  setPermissionMessage(
                    gt(
                      "Notifications need a supported browser over HTTPS, or the desktop app. Sound only is still available.",
                    ),
                  );
                  return;
                }
                setRequesting(true);
                const permission = await settlePromise(() => Notification.requestPermission());
                setRequesting(false);
                if (permission._tag === "Failure") {
                  setPermissionMessage(
                    gt(
                      "Notifications are unavailable in this browser. Sound only is still available.",
                    ),
                  );
                  return;
                }
                if (permission.value !== "granted") {
                  setPermissionMessage(
                    gt(
                      "Allow notifications in your browser or system settings, then choose this option again. Sound only is still available.",
                    ),
                  );
                  return;
                }
              }
              updateSettings({ notificationMode: value });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-56"
              aria-label={gt("Thread notifications")}
            >
              <SelectValue>{m(NOTIFICATION_MODE_LABELS[mode])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
                <SelectItem key={value} hideIndicator value={value}>
                  {m(label)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {(
        [
          ["completionSound", gt("Completion sound"), "completion"],
          ["inputSound", gt("Input sound"), "input"],
          ["approvalSound", gt("Approval sound"), "input"],
        ] as const
      ).map(([key, label, kind]) => (
        <SettingsRow
          key={key}
          title={label}
          control={
            <div className="flex items-center gap-2">
              <Select
                value={settings[key]}
                disabled={!hasNotificationSound(mode)}
                onValueChange={(value) => {
                  if (value && Object.hasOwn(NOTIFICATION_SOUND_LABELS, value))
                    updateSettings({ [key]: value as NotificationSound });
                }}
              >
                <SelectTrigger size="sm" className="w-40" aria-label={label}>
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
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label={gt("Preview sound")}
                disabled={!hasNotificationSound(mode) || settings[key] === "none"}
                onClick={async () => {
                  await unlockNotificationAudio();
                  void playNotificationSound(kind, () => true, settings[key]);
                }}
              >
                <Volume2Icon />
              </Button>
            </div>
          }
        />
      ))}
    </>
  );
}
