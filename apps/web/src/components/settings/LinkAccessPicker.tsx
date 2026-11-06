import {
  LINK_ACCESS_CHOICES,
  linkAccessChoice,
  linkAccessLabel,
} from "@t3tools/client-runtime/link-request";
import type { AuthMcpClientAccess } from "@t3tools/contracts";
import { useId } from "react";

import { accessConfig } from "../auth/ConnectAgentSurface";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** What agents here may do on another machine, with what that does not allow. */
export function LinkAccessPicker({
  value,
  onChange,
  disabled = false,
}: {
  readonly value: AuthMcpClientAccess;
  readonly onChange: (access: AuthMcpClientAccess) => void;
  readonly disabled?: boolean;
}) {
  const labelId = useId();
  const selected = linkAccessChoice(value);
  const SelectedIcon = accessConfig[selected.access].icon;
  return (
    <div className="space-y-1.5">
      <span id={labelId} className="block text-xs font-medium">
        What agents here may do there
      </span>
      <Select
        value={selected.access}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== null) onChange(next as AuthMcpClientAccess);
        }}
      >
        <SelectTrigger aria-labelledby={labelId}>
          <SelectValue>
            <span className="flex items-center gap-2">
              <SelectedIcon aria-hidden className="size-4" />
              {linkAccessLabel(value)}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {LINK_ACCESS_CHOICES.map(({ access, label, description }) => {
            const Icon = accessConfig[access].icon;
            return (
              <SelectItem key={access} value={access} hideIndicator>
                <span className="grid min-w-0 gap-0.5 py-0.5">
                  <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                    <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    {label}
                  </span>
                  <span className="text-xs leading-4 text-muted-foreground">{description}</span>
                </span>
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>
      <p className="text-xs text-muted-foreground">
        {selected.description} An agent never gets more access there than its own mode here.
      </p>
    </div>
  );
}
