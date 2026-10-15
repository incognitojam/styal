import { useState, useSyncExternalStore } from "react";
import { pullRequestAnnouncementText } from "@t3tools/client-runtime/pull-request-announcements";

import {
  ANNOUNCER_SAMPLES,
  announcerPlayer,
  getAnnouncerPlayback,
  subscribeAnnouncerPlayback,
} from "../../announcer";
import { hasNotificationSound } from "../../threadNotifications";
import { Button } from "../ui/button";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function AnnouncerPreview() {
  const [selected, setSelected] = useState<string>(ANNOUNCER_SAMPLES[0].id);
  const [number, setNumber] = useState(831);
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const state = useSyncExternalStore(subscribeAnnouncerPlayback, getAnnouncerPlayback);
  const sample = ANNOUNCER_SAMPLES.find((item) => item.id === selected) ?? ANNOUNCER_SAMPLES[0];

  return (
    <SettingsRow
      {...searchableSetting("announcer-preview")}
      description={state.current?.text ?? pullRequestAnnouncementText(number, sample.id)}
      control={
        <Switch
          aria-label="Announcer"
          checked={settings.pullRequestAnnouncerEnabled}
          disabled={!hasNotificationSound(settings.notificationMode)}
          onCheckedChange={(checked) => {
            if (checked) void announcerPlayer.unlock();
            else announcerPlayer.stop();
            updateSettings({ pullRequestAnnouncerEnabled: checked });
          }}
        />
      }
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 py-2">
        <div className="w-full min-w-0 max-w-80">
          <Select value={sample.id} onValueChange={(value) => value && setSelected(value)}>
            <SelectTrigger size="sm" aria-label="Announcer">
              <SelectValue>
                <span className="block truncate">{sample.label}</span>
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {ANNOUNCER_SAMPLES.map((item) => (
                <SelectItem key={item.id} hideIndicator value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="w-24">
          <NumberField
            size="sm"
            value={number}
            min={1}
            max={Number.MAX_SAFE_INTEGER}
            step={1}
            onValueChange={(value) => {
              if (value !== null && Number.isSafeInteger(value)) setNumber(value);
            }}
          >
            <NumberFieldGroup>
              <NumberFieldInput aria-label="Pull request" />
            </NumberFieldGroup>
          </NumberField>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await announcerPlayer.unlock();
            announcerPlayer.preview(sample, number);
          }}
        >
          Preview
        </Button>
        <Button
          variant="ghost-muted"
          size="sm"
          onClick={async () => {
            await announcerPlayer.unlock();
            announcerPlayer.preview(sample, null);
          }}
        >
          Announcer v4
        </Button>
        <Button
          variant="ghost-muted"
          size="sm"
          disabled={!state.playing}
          onClick={() => announcerPlayer.stop()}
        >
          Stop
        </Button>
      </div>
      {state.error ? <p role="alert">{state.error}</p> : null}
    </SettingsRow>
  );
}
