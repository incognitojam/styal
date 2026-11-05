import { ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { SettingsRow } from "./settingsLayout";

/** A settings row saying a config file was partly ignored, with what was ignored behind a toggle. */
export function ConfigFileIssuesRow({
  title,
  description,
  messages = [],
}: {
  title: string;
  description?: string;
  messages?: ReadonlyArray<string>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <SettingsRow
        title={
          <span className="flex items-center gap-1.5">
            <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
            {title}
          </span>
        }
        description={description}
        control={
          messages.length > 0 ? (
            <CollapsibleTrigger render={<Button variant="ghost-muted" size="xs" />}>
              {open ? "Hide details" : "Show details"}
              <ChevronDownIcon
                aria-hidden
                className={cn("transition-transform", open && "rotate-180")}
              />
            </CollapsibleTrigger>
          ) : null
        }
      />
      {messages.length > 0 ? (
        <CollapsiblePanel>
          <ul className="flex flex-col gap-1 px-3 pb-3 text-xs text-muted-foreground sm:px-4">
            {[...new Set(messages)].map((message) => (
              <li key={message} className="whitespace-pre-wrap break-words">
                {message}
              </li>
            ))}
          </ul>
        </CollapsiblePanel>
      ) : null}
    </Collapsible>
  );
}
