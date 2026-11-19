import { ComposerSelectControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { ShortcutHintBadge } from "./ShortcutHint";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import type { EnvironmentId } from "@t3tools/contracts";
import { PlusIcon, ScaleIcon, SlidersHorizontalIcon } from "lucide-react";
import { memo } from "react";

import type { AddProjectTarget } from "../hooks/useAddProjectTargets";
import type { EnvironmentOption } from "./BranchToolbar.logic";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectValue,
} from "./ui/select";

interface BranchToolbarEnvironmentSelectorProps {
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  addTargets?: readonly AddProjectTarget[] | undefined;
  /** Adds to the named machine, or opens the dialog for null. */
  onAddToMachine?: ((environmentId: EnvironmentId | null) => void) | undefined;
  /** Why the Add rows are unavailable, while a one-click add is decided or sent. */
  addBusyReason?: string | null | undefined;
}

// Action values cannot collide with server-minted environment IDs.
const AUTO_VALUE = "action:auto";
const ADD_OPTIONS_VALUE = "action:add-options";
const addValue = (id: EnvironmentId) => `add:${id}`;
const environmentValue = (id: EnvironmentId) => `env:${id}`;

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  addTargets = [],
  onAddToMachine,
  addBusyReason = null,
}: BranchToolbarEnvironmentSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.host",
  );
  const activeEnvironment =
    availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;

  const environmentItems = [
    ...(onAutoEnvironment
      ? [{ value: AUTO_VALUE, label: autoEnvironmentLabel ?? "Auto balance" }]
      : []),
    ...availableEnvironments.map((env) => ({
      value: environmentValue(env.environmentId),
      label: env.label,
    })),
    ...(onAddToMachine
      ? [
          ...addTargets.map((target) => ({
            value: addValue(target.environmentId),
            label: `Add to ${target.label}`,
          })),
          { value: ADD_OPTIONS_VALUE, label: "Add with options…" },
        ]
      : []),
  ];

  // Match the xs control's height and padding: the composer strip has no min-height,
  // and its glass seam assumes that height even when this label is the only control.
  if (envLocked || (onEnvironmentChange === undefined && onAddToMachine === undefined)) {
    const lockedRow = (
      <span
        className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-sm sm:h-6 sm:text-xs"
        data-composer-context-control
      >
        <EnvironmentMachineIcon
          kind={activeEnvironment?.machine ?? "server"}
          className="size-3 shrink-0"
        />
        <ComposerContextLabel>{activeEnvironment?.label ?? "Run on"}</ComposerContextLabel>
      </span>
    );
    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>{activeEnvironment?.label ?? "Run on"}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={autoEnvironmentLabel ? AUTO_VALUE : environmentValue(environmentId)}
      onValueChange={(value) => {
        if (value === ADD_OPTIONS_VALUE) {
          onAddToMachine?.(null);
        } else if (value?.startsWith("add:")) {
          onAddToMachine?.(value.slice(4) as EnvironmentId);
        } else if (value === AUTO_VALUE) {
          onAutoEnvironment?.();
        } else if (value?.startsWith("env:")) {
          onEnvironmentChange?.(value.slice(4) as EnvironmentId);
        }
      }}
      items={environmentItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size="xs"
              className="min-w-0 max-w-full"
              aria-label="Run on"
              data-composer-shortcut="composer.host"
              data-composer-context-control
            />
          }
        >
          <ShortcutHintBadge command="composer.host" />
          {autoEnvironmentLabel ? (
            <ScaleIcon className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <EnvironmentMachineIcon
              kind={activeEnvironment?.machine ?? "server"}
              className="size-3 shrink-0"
            />
          )}
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on"}
          {shortcutLabel ? ` · ${shortcutLabel}` : null}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>Run on</SelectGroupLabel>
          {onAutoEnvironment && (
            <SelectItem
              value={AUTO_VALUE}
              onClick={() => {
                if (autoEnvironmentLabel) onAutoEnvironment?.();
              }}
            >
              <span className="inline-flex items-center gap-1.5">
                <ScaleIcon className="size-3" aria-hidden="true" />
                {autoEnvironmentLabel ?? "Auto balance"}
              </span>
            </SelectItem>
          )}
          {availableEnvironments.map((env) => (
            <SelectItem
              key={env.environmentId}
              value={environmentValue(env.environmentId)}
              disabled={onEnvironmentChange === undefined && env.environmentId !== environmentId}
            >
              <span className="inline-flex items-center gap-1.5">
                <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                {env.label}
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
        {onAddToMachine ? (
          <>
            <SelectSeparator />
            <SelectGroup>
              {addTargets.map((target) => (
                <SelectItem
                  key={target.environmentId}
                  value={addValue(target.environmentId)}
                  disabled={addBusyReason !== null}
                >
                  <AddTargetLabel target={target} busyReason={addBusyReason} />
                </SelectItem>
              ))}
              <SelectItem value={ADD_OPTIONS_VALUE} disabled={addBusyReason !== null}>
                <AddWithOptionsLabel />
              </SelectItem>
            </SelectGroup>
          </>
        ) : null}
      </SelectPopup>
    </Select>
  );
});

/** Adding the project to one machine, with the folder the clone lands in or why it cannot start yet. */
export function AddTargetLabel({
  target,
  busyReason = null,
}: {
  target: AddProjectTarget;
  busyReason?: string | null;
}) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex min-w-0 items-center gap-1.5">
        <PlusIcon aria-hidden="true" className="size-3 shrink-0" />
        <span className="min-w-0 truncate">Add to {target.label}</span>
      </span>
      {busyReason === null ? (
        <span className="truncate ps-4.5 font-mono text-muted-foreground text-xs">
          {target.destinationPath}
        </span>
      ) : (
        <span className="truncate ps-4.5 text-muted-foreground text-xs">{busyReason}</span>
      )}
    </span>
  );
}

/** Opens the dialog to pick the machine, folder, protocol and files to copy. */
export function AddWithOptionsLabel() {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <SlidersHorizontalIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="min-w-0 truncate">Add with options…</span>
    </span>
  );
}
