import { simulatorMemorySelection } from "@t3tools/client-runtime/device/simulator-memory";
import type { SimulatorMemoryState } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import type { DeviceControls } from "./useDeviceControls";

export function SimulatorMemoryControls({
  memory,
  controls,
}: {
  readonly memory: SimulatorMemoryState;
  readonly controls: DeviceControls;
}) {
  const [mode, setMode] = useState<"standard" | "low-memory">(
    memory.mode === "standard" ? "standard" : "low-memory",
  );
  const [keep, setKeep] = useState<ReadonlyArray<string>>(() => simulatorMemorySelection(memory));

  if (!memory.supported)
    return (
      <p className="text-xs text-muted-foreground">
        Memory profiles currently require an Apple Silicon Mac.
      </p>
    );
  if (!memory.installed)
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Reduce this simulator's memory use by disabling services your app does not need. Set up
          SimSlim on its Mac, then choose the capabilities to keep.
        </p>
        <Button
          size="xs"
          variant="outline"
          disabled={controls.disabled}
          onClick={() => void controls.act({ type: "prepareSimulatorMemory" })}
        >
          Set up memory controls
        </Button>
      </div>
    );

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {memory.mode === "standard" ? "Standard services" : "Low-memory profile"} ·{" "}
        {memory.disabledServices ?? 0} services disabled
      </p>
      <ToggleGroup
        aria-label="Simulator memory mode"
        value={[mode]}
        disabled={controls.disabled}
        onValueChange={(values) => {
          const value = values[0];
          if (value === "standard" || value === "low-memory") setMode(value);
        }}
      >
        <Toggle value="standard">Standard</Toggle>
        <Toggle value="low-memory">Low memory</Toggle>
      </ToggleGroup>
      {mode === "low-memory" ? (
        <fieldset disabled={controls.disabled} className="space-y-2">
          <legend className="mb-2 text-xs font-medium">Keep available for this app</legend>
          <div className="grid max-h-56 gap-2 overflow-y-auto py-0.5">
            {memory.capabilities.map((capability) => (
              <label key={capability.id} className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={keep.includes(capability.id)}
                  onCheckedChange={(checked) =>
                    setKeep((current) =>
                      checked
                        ? [...current, capability.id]
                        : current.filter((id) => id !== capability.id),
                    )
                  }
                />
                {capability.name}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {memory.persistent === false ? (
        <p className="text-xs text-muted-foreground">
          Low-memory profiles require iOS 18.5 or newer. You can still restore standard services.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Applying restarts this simulator and affects every app on it. The profile stays across
        reboots until restored or the simulator is erased.
      </p>
      <Button
        size="xs"
        variant="outline"
        disabled={controls.disabled || (mode === "low-memory" && memory.persistent === false)}
        onClick={() =>
          void controls.act(
            mode === "standard"
              ? { type: "setMemoryProfile", mode }
              : { type: "setMemoryProfile", mode, keepCapabilities: keep },
          )
        }
      >
        {mode === "standard" ? "Restore standard services" : "Apply low-memory profile"}
      </Button>
      {memory.capabilities.some((capability) => !capability.enabled) ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Disabled capabilities</summary>
          <ul className="mt-2 space-y-2">
            {memory.capabilities
              .filter((capability) => !capability.enabled)
              .map((capability) => (
                <li key={capability.id}>{capability.name}</li>
              ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
