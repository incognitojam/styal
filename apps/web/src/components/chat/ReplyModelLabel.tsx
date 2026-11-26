import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react";
import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { useV2ItemSupport } from "../../state/v2ItemSupport";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { cn } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export function ReplyModelLabel(props: {
  environmentId: EnvironmentId;
  sourceThreadId: ThreadId;
  sourceItemId: TurnItemId;
}) {
  const gt = useGT();
  const support = useV2ItemSupport(props);
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(props.environmentId));
  const selection = support.run?.modelSelection;
  const model = support.providerTurn?.model ?? selection?.model;
  if (!model) return null;
  const name =
    providers
      .find((p) => p.instanceId === selection?.instanceId)
      ?.models.find((m) => m.slug === model)?.name ?? formatModelSlugName(model);
  const reportedUsage = support.providerTurn?.turnTokenUsage;
  const usage = reportedUsage?.localCommand ? undefined : reportedUsage;
  const input = Math.max(
    usage?.inputTokens ?? 0,
    (usage?.cachedInputTokens ?? 0) + (usage?.cacheCreationTokens ?? 0),
  );
  const output = usage?.outputTokens ?? 0;
  const rows = [{ label: gt("Input"), value: formatTokens(input), indent: false }];
  if (usage?.cachedInputTokens !== undefined || usage?.cacheCreationTokens !== undefined) {
    rows.push({
      label: gt("Cache reads"),
      value: formatTokens(usage.cachedInputTokens ?? 0),
      indent: true,
    });
    if (usage.cacheCreationTokens)
      rows.push({
        label: gt("Cache writes"),
        value: formatTokens(usage.cacheCreationTokens),
        indent: true,
      });
    rows.push({
      label: gt("Uncached"),
      value: formatTokens(
        Math.max(0, input - (usage.cachedInputTokens ?? 0) - (usage.cacheCreationTokens ?? 0)),
      ),
      indent: true,
    });
  }
  rows.push({
    label: gt("Output"),
    value: usage?.reasoningTokens
      ? gt("{output} ({reasoning} reasoning)", {
          output: formatTokens(output),
          reasoning: formatTokens(usage.reasoningTokens),
        })
      : formatTokens(output),
    indent: false,
  });
  const notes = [
    ...(usage?.usageStatus !== "complete"
      ? [gt("The provider has not reported complete usage for this turn.")]
      : []),
    ...(usage?.hasSubagents ? [gt("Subagent usage is not included.")] : []),
  ];
  const text = gt("{tokens} tokens", { tokens: formatTokens(input + output) });
  return (
    <>
      <span aria-hidden="true">·</span>
      <span className="truncate">{name}</span>
      {usage ? (
        <>
          <span aria-hidden="true">·</span>
          <Popover>
            <PopoverTrigger
              openOnHover
              delay={150}
              closeDelay={0}
              aria-label={gt("Turn usage: {usage}", { usage: text })}
              render={
                <button
                  type="button"
                  className="shrink-0 cursor-default rounded-sm text-xs tabular-nums outline-none hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
              }
            >
              {text}
            </PopoverTrigger>
            <PopoverPopup
              tooltipStyle
              side="top"
              align="start"
              padding="none"
              className="w-max min-w-56 max-w-none text-left whitespace-normal"
            >
              <div className="flex flex-col gap-2 p-(--floating-content-inset)">
                <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-2xs leading-4">
                  {rows.map((row, index) => (
                    <div key={row.label} className="contents">
                      <dt
                        className={cn(
                          "whitespace-nowrap text-muted-foreground",
                          row.indent && "pl-2.5",
                        )}
                      >
                        {row.indent ? (
                          <span className="sr-only">
                            {rows.slice(0, index).findLast((parent) => !parent.indent)?.label}:{" "}
                          </span>
                        ) : null}
                        {row.label}
                      </dt>
                      <dd className="whitespace-nowrap text-right font-medium tabular-nums text-muted-foreground">
                        {row.value}
                      </dd>
                    </div>
                  ))}
                </dl>
                {notes.map((note) => (
                  <p
                    key={note}
                    className="w-0 min-w-full text-pretty text-muted-foreground text-2xs"
                  >
                    {note}
                  </p>
                ))}
              </div>
            </PopoverPopup>
          </Popover>
        </>
      ) : null}
    </>
  );
}
