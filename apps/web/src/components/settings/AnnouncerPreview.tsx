import { useEffect, useRef, useState } from "react";

import { ANNOUNCER_SAMPLES, createAnnouncerPlayer } from "../../announcer";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function AnnouncerPreview() {
  const [selected, setSelected] = useState<string>(ANNOUNCER_SAMPLES[0].id);
  const [state, setState] = useState<{ playing: boolean; error: string | null }>({
    playing: false,
    error: null,
  });
  const player = useRef<ReturnType<typeof createAnnouncerPlayer> | null>(null);
  const sample = ANNOUNCER_SAMPLES.find((item) => item.id === selected) ?? ANNOUNCER_SAMPLES[0];

  useEffect(() => {
    const instance = createAnnouncerPlayer(setState);
    player.current = instance;
    return () => {
      player.current = null;
      instance.dispose();
    };
  }, []);

  return (
    <SettingsRow
      {...searchableSetting("announcer-preview")}
      description={sample.text}
      control={
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
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
          <Button variant="outline" size="sm" onClick={() => player.current?.enqueue(sample)}>
            Preview
          </Button>
          <Button
            variant="ghost-muted"
            size="sm"
            disabled={!state.playing}
            onClick={() => player.current?.stop()}
          >
            Stop
          </Button>
        </div>
      }
    >
      {state.error ? <p role="alert">{state.error}</p> : null}
    </SettingsRow>
  );
}
