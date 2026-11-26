import { useLocale, useMessages } from "gt-react";
import { useClientSettings } from "../../hooks/useSettings";
import { describeMentionedTime } from "./mentionedTimeDetails";
import type {
  MentionedTime,
  MentionedTimeAnchor,
  ResolvedMentionedTime,
} from "./mentionedTimePresentation";
import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { mentionedTimes } from "./mentionedTimes";

function textOf(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? textOf(child.props.children)
          : "",
    )
    .join("");
}

export function renderMentionedTimes(
  children: ReactNode,
  reference = new Date(),
  before = "",
): ReactNode {
  let previous = before;
  return Children.map(children, (child) => {
    const prefix = previous;
    previous = (previous + textOf(child)).slice(-160);
    if (typeof child === "string") {
      const times = mentionedTimes(child, reference, prefix);
      if (!times.length) return child;
      const nodes: ReactNode[] = [];
      let end = 0;
      for (const time of times) {
        nodes.push(
          child.slice(end, time.start),
          <Tooltip key={time.start}>
            <TooltipTrigger
              render={
                <span
                  tabIndex={0}
                  className="cursor-default rounded-sm bg-foreground/[0.06] px-0.75 box-decoration-clone hover:bg-foreground/10"
                />
              }
            >
              {time.text.slice(0, time.chipEnd - time.start)}
            </TooltipTrigger>
            <TooltipPopup side="top">
              <MentionedTimeDetails
                time={time.time}
                anchor={{ writtenAtMs: reference.getTime() }}
                resolved={{
                  instantMs: time.instant,
                  assumedDay: time.assumedDate,
                }}
              />
            </TooltipPopup>
          </Tooltip>,
          time.text.slice(time.chipEnd - time.start),
        );
        end = time.end;
      }
      nodes.push(child.slice(end));
      return nodes;
    }
    if (!isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(child)) return child;
    const tag = typeof child.type === "string" ? child.type : child.props.node?.tagName;
    if (tag === "code" || tag === "a" || tag === "p" || !child.props.children) return child;
    return cloneElement(
      child,
      undefined,
      renderMentionedTimes(child.props.children, reference, prefix),
    );
  });
}

/** Mounted only while the tooltip is open, so "in 3 hours" is computed then and never ticks. */
function MentionedTimeDetails(props: {
  time: MentionedTime;
  anchor: MentionedTimeAnchor;
  resolved: ResolvedMentionedTime;
}) {
  const resolve = useMessages();
  const locale = useLocale();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { lead, detail, note } = describeMentionedTime(props.time, props.anchor, props.resolved, {
    timestampFormat,
    resolve,
    locale,
  });
  return (
    <div className="flex flex-col gap-0.5">
      <span>
        <span className="font-medium">{lead}</span>
        {detail === null ? null : <span className="text-muted-foreground"> · {detail}</span>}
      </span>
      {note === null ? null : <span className="text-muted-foreground text-xs">{note}</span>}
    </div>
  );
}
