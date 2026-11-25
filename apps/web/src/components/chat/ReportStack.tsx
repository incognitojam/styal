import type {
  EnvironmentId,
  MessageId,
  ScopedThreadRef,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { formatReportAnswer } from "@t3tools/client-runtime/coordinator-reports";
import { CheckIcon, EllipsisIcon, ListEndIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";

import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ReportReference, ReportState } from "./CoordinatorReports";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  answerReportStack,
  closedReportStack,
  closeReportStack,
  deferReportStack,
  landReportStack,
  openReportStack,
  reportAfter,
  reportStackEdges,
  reportStackKey,
  reportStackOrder,
  type ReportStackView,
  reportStackTop,
} from "./reportStack.logic";
import { MESSAGE_HEADING_LEVEL } from "./TimelineRowParts";
import { SidebarAttentionIcon } from "../sidebar/attentionStatus";

export type ReportStackActions = {
  answer: (text: string, ref: ReportReference) => void;
  reply: (ref: ReportReference, title: string) => void;
  dismiss: (ref: ReportReference) => void;
  scroll: (id: MessageId) => void;
};

type View = ReportStackView<ReportState> & { readonly threadKey: string | null };

const closed = (threadKey: string | null): View => ({ ...closedReportStack, threadKey });

const reference = (report: ReportState): ReportReference => {
  const tag = report.message.report!;
  return { messageId: report.message.id, key: tag.key, version: tag.version };
};

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A thread's open reports, one at a time, in place of the chat. */
export function useReportStack(
  threadKey: string | null,
  reports: readonly ReportState[],
  actions: ReportStackActions | null,
  focusComposer: () => void,
) {
  const [view, setView] = useState(() => closed(threadKey));
  if (view.threadKey !== threadKey) setView(closed(threadKey));
  // The pile's button, focused again when the stack closes.
  const [pile, setPile] = useState<HTMLButtonElement | null>(null);
  const order = actions ? reportStackOrder(reports, view.later) : [];
  const top = reportStackTop(order, view);
  // Once the topic being read closes some other way, the report now on screen is the one read.
  const topKey = top === null ? null : top.message.report!.key;
  if (view.open && topKey !== null && view.current !== topKey)
    setView({ ...view, current: topKey });
  const apply = (next: ReportStackView<ReportState> | null) => {
    if (next !== null) setView({ ...next, threadKey: view.threadKey });
    return next !== null;
  };
  // The lift's fallback, in case its animation never reports its end.
  const liftTimer = useRef<number | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the lift's fallback timer when the stack unmounts
  useEffect(() => () => window.clearTimeout(liftTimer.current), []);
  const landed = (lift: number) => {
    window.clearTimeout(liftTimer.current);
    setView((previous) => ({ ...previous, leaving: landReportStack(previous, lift).leaving }));
  };
  const close = () => {
    window.clearTimeout(liftTimer.current);
    flushSync(() => apply(closeReportStack(view)));
    if (pile) pile.focus();
    else focusComposer();
  };
  return {
    view,
    order,
    top,
    setPile,
    open: () => apply(openReportStack(view, order)),
    close,
    showAll: (all: boolean) => setView({ ...view, all, leaving: null }),
    pick: (key: string) =>
      setView({ ...view, current: key, all: false, leaving: null, answered: null }),
    later: (report: ReportState) => apply(deferReportStack(view, order, report)),
    answer: (report: ReportState, answer: string) => {
      const motion = !prefersReducedMotion();
      const next = answerReportStack(view, order, report, answer, motion);
      if (!apply(next)) return;
      if (motion && next) {
        window.clearTimeout(liftTimer.current);
        liftTimer.current = window.setTimeout(() => landed(next.lift), 500);
      }
      const tag = report.message.report!;
      actions?.answer(formatReportAnswer(tag, answer), reference(report));
    },
    landed,
    reply: (report: ReportState) => {
      close();
      actions?.reply(reference(report), report.message.report!.title);
    },
    dismiss: (report: ReportState) => {
      setView({
        ...view,
        current: reportAfter(order, report.message.report!.key),
        answered: null,
      });
      actions?.dismiss(reference(report));
    },
    showInChat: (report: ReportState) => {
      close();
      actions?.scroll(report.message.id);
    },
  };
}

type ReportStackState = ReturnType<typeof useReportStack>;

function PileEdges({ count, onShowAll }: { count: number; onShowAll?: () => void }) {
  if (count === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-full flex flex-col-reverse items-center">
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className={cn(
            "h-[7px] rounded-t-xl border border-b-0 border-border bg-card",
            index === 0 && "w-[calc(100%-1.25rem)]",
            index === 1 && "w-[calc(100%-2.5rem)]",
            index === 2 && "w-[calc(100%-3.75rem)]",
          )}
        />
      ))}
      {onShowAll ? (
        <button
          type="button"
          aria-label="Everything waiting"
          className="pointer-events-auto absolute inset-x-6 -top-1 bottom-0 cursor-pointer rounded-t-lg focus-visible:outline-2 focus-visible:outline-ring"
          onClick={onShowAll}
        />
      ) : null}
    </div>
  );
}

/** A report other work waits on: a short amber tab on the left edge, no label. */
function BlockingMark({ className }: { className: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn("absolute left-0 w-[3px] rounded-r-full bg-warning", className)} />
        }
      >
        <span className="sr-only">Other work is waiting on this.</span>
      </TooltipTrigger>
      <TooltipPopup side="left">Other work is waiting on this</TooltipPopup>
    </Tooltip>
  );
}

/** Above the composer: the report on top of the pile, opening the stack. */
export function ReportPile({ stack }: { stack: ReportStackState }) {
  const { top, order, open, setPile } = stack;
  if (top === null) return null;
  const tag = top.message.report!;
  return (
    <div className="relative mx-3 mt-2 mb-2 sm:mx-4">
      <PileEdges count={reportStackEdges(order.length)} />
      <button
        ref={setPile}
        type="button"
        onClick={open}
        aria-label={`Open reports waiting on you: ${tag.title}`}
        // The hover tint sits over bg-card; an accent background alone is see-through over the chat.
        className="relative isolate flex w-full cursor-pointer items-center gap-3 overflow-hidden rounded-xl border border-border/80 bg-card px-4 py-2.5 text-left shadow-xs/5 outline-none before:absolute before:inset-0 before:-z-10 hover:before:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {tag.blocking ? <BlockingMark className="inset-y-2.5" /> : null}
        <SidebarAttentionIcon attention="input" />
        <span className="min-w-0 flex-1 truncate text-sm">
          <span className="font-medium text-foreground">{tag.title}</span>
          <span className="ms-2 text-muted-foreground">{tag.question}</span>
        </span>
      </button>
    </div>
  );
}

type MarkdownSurface = {
  cwd: string | undefined;
  threadRef: ScopedThreadRef | null;
  environmentId: EnvironmentId;
  skills: ReadonlyArray<ServerProviderSkill>;
  onImageExpand: (preview: ExpandedImagePreview) => void;
};

const focusOnMount = (element: HTMLElement | null) => element?.focus({ preventScroll: true });

/** Takes the chat's place while you work through the open reports. */
export function ReportStack({
  stack,
  canOperate,
  inChat,
  markdown,
}: {
  stack: ReportStackState;
  canOperate: boolean;
  /** Whether the chat has the report's message loaded, so Show in chat can reach it. */
  inChat: (messageId: MessageId) => boolean;
  markdown: MarkdownSurface;
}) {
  const { view, top } = stack;
  if (!view.open) return null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable='true'], [role='menu']")) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const action = reportStackKey(
      event,
      view,
      top === null ? [] : (top.message.report!.answers ?? []),
    );
    if (action === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (action.kind === "close") stack.close();
    else if (action.kind === "back") stack.showAll(false);
    else if (top === null) return;
    else if (action.kind === "later") stack.later(top);
    else if (action.kind === "answer" && canOperate) stack.answer(top, action.answer);
  };
  return (
    <div
      role="region"
      aria-label="Reports waiting on you"
      // Claims the keys from type-to-focus, which would send them to the hidden composer.
      aria-keyshortcuts="1 2 3 4 ArrowRight Escape"
      className="absolute inset-0 z-40 flex flex-col overflow-hidden bg-background pb-safe"
      onKeyDown={onKeyDown}
    >
      <div className="chat-composer-lane flex min-h-0 flex-1 flex-col pt-12 pb-3 sm:pt-14 sm:pb-4">
        <div className="relative mx-auto flex min-h-0 w-full max-w-(--chat-content-max-width) flex-1 flex-col">
          <div
            aria-live="polite"
            className="pointer-events-none absolute inset-x-0 -top-11 flex h-6 items-center justify-center sm:-top-12"
          >
            {view.answered ? (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs transition-opacity duration-300 starting:opacity-0 motion-reduce:transition-none [&_svg]:size-3.5">
                <CheckIcon aria-hidden />
                <span className="sr-only">Answered: </span>
                {view.answered}
              </span>
            ) : null}
          </div>
          {view.leaving && !view.all ? (
            <Sheet
              key={`leaving-${view.leaving.message.id}`}
              report={view.leaving}
              stack={stack}
              remaining={0}
              leaving
              canOperate={false}
              inChat={inChat}
              markdown={markdown}
            />
          ) : null}
          {view.all ? (
            <AllWaiting stack={stack} />
          ) : top ? (
            <Sheet
              key={top.message.report!.key}
              report={top}
              stack={stack}
              remaining={stack.order.length}
              leaving={false}
              canOperate={canOperate}
              inChat={inChat}
              markdown={markdown}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 pb-16 text-center">
              <p className="text-balance font-medium text-foreground text-lg">
                Nothing else needs you.
              </p>
              <Button ref={focusOnMount} variant="outline" onClick={stack.close}>
                Back to chat
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Sheet({
  report,
  stack,
  remaining,
  leaving,
  canOperate,
  inChat,
  markdown,
}: {
  report: ReportState;
  stack: ReportStackState;
  remaining: number;
  leaving: boolean;
  canOperate: boolean;
  inChat: (messageId: MessageId) => boolean;
  markdown: MarkdownSurface;
}) {
  const tag = report.message.report!;
  return (
    <section
      ref={leaving ? undefined : focusOnMount}
      tabIndex={-1}
      aria-label={tag.title}
      inert={leaving}
      className={cn(
        "flex min-h-0 flex-1 flex-col outline-none",
        leaving
          ? "pointer-events-none absolute inset-0 z-10 animate-report-lift"
          : "relative transition-[opacity,translate] duration-200 ease-out starting:translate-y-1.5 starting:opacity-0 motion-reduce:transition-none",
      )}
      onAnimationEnd={(event) => {
        if (leaving && event.target === event.currentTarget) stack.landed(stack.view.lift);
      }}
    >
      <PileEdges count={reportStackEdges(remaining)} onShowAll={() => stack.showAll(true)} />
      <article className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm/5 dark:shadow-none">
        {tag.blocking ? <BlockingMark className="top-6 h-6 sm:top-9" /> : null}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-8 sm:px-9 sm:pt-8">
          <div className="flex items-start gap-3">
            <h2 className="min-w-0 flex-1 text-balance font-semibold text-foreground text-xl tracking-tight">
              {tag.title}
            </h2>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label="Back to chat"
                    className="-me-2 -mt-0.5 sm:-me-4"
                    onClick={stack.close}
                  />
                }
              >
                <XIcon />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Back to chat · Esc</TooltipPopup>
            </Tooltip>
          </div>
          <div className="mt-3">
            <ChatMarkdown
              text={report.message.text}
              cwd={markdown.cwd}
              threadRef={markdown.threadRef ?? undefined}
              environmentId={markdown.environmentId}
              skills={markdown.skills}
              headingLevelOffset={MESSAGE_HEADING_LEVEL}
              onImageExpand={markdown.onImageExpand}
              writtenAt={report.message.createdAt}
            />
          </div>
        </div>
        <div className="border-t border-border/60 bg-muted/40 px-5 pt-4 pb-3 sm:px-9 sm:pt-6 sm:pb-4">
          <p className="font-medium text-base text-foreground">{tag.question}</p>
          {tag.answers?.length ? (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {tag.answers.map((answer, index) => (
                <Button
                  key={answer}
                  size="lg"
                  variant={index === 0 ? "default" : "outline"}
                  disabled={!canOperate}
                  className="max-sm:w-full"
                  onClick={() => stack.answer(report, answer)}
                >
                  {answer}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="-mx-3 mt-3 flex items-center gap-1 sm:mt-4">
            <Button
              size="lg"
              variant="ghost-muted"
              disabled={!canOperate}
              className="min-w-0 flex-1 justify-start"
              onClick={() => stack.reply(report)}
            >
              Reply…
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon"
                    variant="ghost-muted"
                    aria-label="Later"
                    onClick={() => stack.later(report)}
                  />
                }
              >
                <ListEndIcon />
              </TooltipTrigger>
              <TooltipPopup side="top">Later · →</TooltipPopup>
            </Tooltip>
            <Menu>
              <MenuTrigger render={<Button size="icon" variant="ghost-muted" aria-label="More" />}>
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end" side="top" sideOffset={6}>
                <MenuItem onClick={() => stack.showAll(true)}>Everything waiting</MenuItem>
                {inChat(report.message.id) ? (
                  <MenuItem onClick={() => stack.showInChat(report)}>Show in chat</MenuItem>
                ) : null}
                {canOperate ? (
                  <>
                    <MenuSeparator />
                    <MenuItem onClick={() => stack.dismiss(report)}>Dismiss</MenuItem>
                  </>
                ) : null}
              </MenuPopup>
            </Menu>
          </div>
        </div>
      </article>
    </section>
  );
}

function AllWaiting({ stack }: { stack: ReportStackState }) {
  return (
    <section
      ref={focusOnMount}
      tabIndex={-1}
      aria-label="Everything waiting"
      className="relative flex min-h-0 flex-1 flex-col outline-none transition-opacity duration-200 starting:opacity-0 motion-reduce:transition-none"
    >
      <article className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm/5 dark:shadow-none">
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2 sm:px-9 sm:pt-6">
          <h2 className="font-semibold text-foreground text-xl tracking-tight">Waiting on you</h2>
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label="Back to the stack"
            className="-me-2 sm:-me-4"
            onClick={() => stack.showAll(false)}
          >
            <XIcon />
          </Button>
        </div>
        <ol className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 sm:px-5">
          {stack.order.map((report) => {
            const tag = report.message.report!;
            return (
              <li key={report.message.id}>
                <button
                  type="button"
                  onClick={() => stack.pick(tag.key)}
                  className="relative flex w-full cursor-pointer flex-col gap-0.5 overflow-hidden rounded-lg px-3 py-2.5 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-4"
                >
                  {tag.blocking ? <BlockingMark className="inset-y-2.5" /> : null}
                  <span className="truncate font-medium text-foreground text-sm">{tag.title}</span>
                  <span className="truncate text-muted-foreground text-sm">{tag.question}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </article>
    </section>
  );
}
