import { simulatorMemorySelection } from "@t3tools/client-runtime/device/simulator-memory";
import type {
  DeviceActionInput,
  DeviceSession,
  EnvironmentId,
  SimulatorMemoryState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Sheet } from "../../components/ui/Sheet";
import { deviceEnvironment } from "../../state/device";
import { useAtomCommand } from "../../state/use-atom-command";

export function SimulatorMemorySheet({
  environmentId,
  session,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly session: DeviceSession;
  readonly onClose: () => void;
}) {
  const read = useAtomCommand(deviceEnvironment.detail, { reportFailure: false });
  const action = useAtomCommand(deviceEnvironment.action, { reportFailure: false });
  const [memory, setMemory] = useState<SimulatorMemoryState | null>(null);
  const [keep, setKeep] = useState<ReadonlyArray<string>>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const target = { hostId: session.hostId, deviceId: session.deviceId };
  const update = useCallback((value: SimulatorMemoryState | undefined, error?: string) => {
    setMemory(value ?? null);
    setKeep(value ? simulatorMemorySelection(value) : []);
    setError(error ?? (value ? null : "Memory profiles are unavailable on this server."));
  }, []);
  useEffect(() => {
    let active = true;
    void read({
      environmentId,
      input: { hostId: session.hostId, deviceId: session.deviceId },
    }).then((result) => {
      if (!active) return;
      if (result._tag === "Success") update(result.value.memory, result.value.memoryError);
      else setError(String(Cause.squash(result.cause)));
    });
    return () => {
      active = false;
    };
  }, [environmentId, read, session.hostId, session.deviceId, update]);

  const apply = (input: DeviceActionInput) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    return action({ environmentId, input })
      .then(async (result) => {
        if (result._tag === "Success") update(result.value.memory, result.value.memoryError);
        else {
          const refreshed = await read({ environmentId, input: target });
          if (refreshed._tag === "Success")
            update(refreshed.value.memory, refreshed.value.memoryError);
          else setMemory(null);
          setError(String(Cause.squash(result.cause)));
        }
      })
      .finally(() => {
        busy.current = false;
        setPending(false);
      });
  };

  return (
    <Sheet title="Simulator memory" onClose={onClose}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="gap-4 p-4">
        {error ? (
          <AppText selectable className="text-danger">
            {error}
          </AppText>
        ) : null}
        {!memory && !error ? <AppActivityIndicator /> : null}
        {memory && !memory.supported ? (
          <AppText>Memory profiles currently require an Apple Silicon Mac.</AppText>
        ) : null}
        {memory?.supported && !memory.installed ? (
          <>
            <AppText className="text-foreground-muted">
              Set up SimSlim on the simulator's Mac, then choose the capabilities your app needs.
              Setup does not change simulator services.
            </AppText>
            <Button
              label="Set up memory controls"
              loading={pending}
              onPress={() => void apply({ ...target, type: "prepareSimulatorMemory" })}
            />
          </>
        ) : null}
        {memory?.supported && memory.installed ? (
          <>
            <AppText>
              {memory.mode === "standard" ? "Standard services" : "Low-memory profile"} ·{" "}
              {memory.disabledServices ?? 0} services disabled
            </AppText>
            <AppText className="text-foreground-muted">Keep available for this app</AppText>
            <View>
              {memory.capabilities.map((capability) => (
                <ListToggleRow
                  key={capability.id}
                  label={capability.name}
                  value={keep.includes(capability.id)}
                  disabled={pending}
                  onValueChange={(enabled) =>
                    setKeep((current) =>
                      enabled
                        ? [...current, capability.id]
                        : current.filter((id) => id !== capability.id),
                    )
                  }
                />
              ))}
            </View>
            <AppText className="text-foreground-muted">
              Applying restarts this simulator and affects every app on it. The profile stays across
              reboots until restored or the simulator is erased.
            </AppText>
            {memory.persistent === false ? (
              <AppText>Low-memory profiles require iOS 18.5 or newer.</AppText>
            ) : null}
            <Button
              label="Apply low-memory profile"
              loading={pending}
              disabled={memory.persistent === false}
              onPress={() =>
                void apply({
                  ...target,
                  type: "setMemoryProfile",
                  mode: "low-memory",
                  keepCapabilities: keep,
                })
              }
            />
            <Button
              label="Restore standard services"
              disabled={pending}
              onPress={() => void apply({ ...target, type: "setMemoryProfile", mode: "standard" })}
            />
            {memory.capabilities
              .filter((capability) => !capability.enabled)
              .map((capability) => (
                <AppText key={capability.id} className="text-sm text-foreground-muted">
                  {capability.name}
                </AppText>
              ))}
          </>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}
