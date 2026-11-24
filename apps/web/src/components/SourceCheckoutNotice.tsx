import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { FolderDownIcon, TriangleAlertIcon } from "lucide-react";
import { useRef } from "react";

import { cn } from "~/lib/utils";
import { useProject } from "~/state/entities";
import { gitEnvironment } from "~/state/git";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";
import { useFeatureExplainer } from "./explainer/FeatureExplainerDialog";
import { worktreeSourcesExplainer } from "./settings/worktreeSourcesExplainer";
import { Button, InlineButton } from "./ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { Spinner } from "./ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// Same words as the setting ("Free source files in settled worktrees") and its walkthrough.
const COPY = {
  released: {
    label: "Source files freed",
    line: "Source files freed to save disk space",
    why: "This thread is settled, so styal removed unchanged files to save disk space. Your changes are kept.",
    after: "Check out brings them back. Sending a message or opening a terminal does too.",
  },
  "recovery-required": {
    label: "Source checkout interrupted",
    line: "Source checkout interrupted",
    why: "Putting the source files back stopped partway. Your changes are kept.",
    after: "Check out finishes putting them back.",
  },
} as const;
const SETTING = "Settings → Worktrees → Free source files in settled worktrees controls this.";
const CONTEXT_SUFFIX = { files: "to list them", skills: "to use project skills" } as const;

export function SourceCheckoutNotice(props: {
  environmentId: EnvironmentId;
  cwd: string;
  layout?: "line" | "panel" | "empty";
  context?: "files" | "skills";
  // Enables "How it works", which names the project and links to its Worktrees settings.
  projectId?: ProjectId | undefined;
  className?: string;
}) {
  const { environmentId, cwd } = props;
  const status = useEnvironmentQuery(vcsEnvironment.status({ environmentId, input: { cwd } }));
  const action = useAtomValue(gitEnvironment.sourceCheckoutAction({ environmentId, cwd }));
  const allowed = useAtomValue(gitEnvironment.checkOutSources.permissionAtom(environmentId));
  const checkOut = useAtomCommand(gitEnvironment.checkOutSources);
  const project = useProject(
    props.projectId === undefined ? null : scopeProjectRef(environmentId, props.projectId),
  );
  const explainer = useFeatureExplainer(
    worktreeSourcesExplainer,
    project ? (
      <>
        On for {project.title} on this machine.{" "}
        <Link
          to="/settings/worktrees"
          search={{ project: derivePhysicalProjectKey(project), machine: undefined }}
          className="font-medium text-foreground underline-offset-2 hover:underline"
        >
          Turn it off in Worktrees settings
        </Link>
        .
      </>
    ) : undefined,
  );
  const rowRef = useRef<HTMLDivElement>(null);
  const state = status.data?.sourceCheckout;
  if (!state) return null;

  const copy = COPY[state];
  const onCheckOut = async () => {
    await checkOut({ environmentId, input: { cwd } });
    status.refresh();
  };
  const error = action.error ? (
    <div role="alert" className="flex min-w-0 items-start gap-1.5 text-start text-destructive">
      <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 wrap-break-word">{action.error}</span>
    </div>
  ) : null;
  const howItWorks = project && state === "released" ? explainer.show : null;

  if (props.layout === "panel") {
    return (
      <div className={cn("flex flex-col", props.className)}>
        <div
          ref={rowRef}
          role="status"
          className={cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex items-center pe-1")}
        >
          {action.pending ? (
            <Spinner size="md" tone="muted" />
          ) : (
            <FolderDownIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          )}
          {action.pending ? (
            <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
              Checking out source files…
            </span>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}
                  />
                }
              >
                {copy.label}
              </TooltipTrigger>
              {/* Anchored to the row so it clears the floating panel instead of covering its icons. */}
              <TooltipPopup side="left" sideOffset={16} anchor={rowRef} className="max-w-72">
                <p>{copy.why}</p>
                <p className="mt-1.5">{copy.after}</p>
                <p className="mt-1.5 text-muted-foreground">{SETTING}</p>
              </TooltipPopup>
            </Tooltip>
          )}
          {action.pending ? null : (
            <ThreadDetailsControl
              part="meta"
              aria-label="Check out source files"
              disabled={!allowed}
              onClick={() => void onCheckOut()}
            >
              Check out
            </ThreadDetailsControl>
          )}
        </div>
        {error ? <div className="ps-9 pe-2.5 pb-1.5 text-xs">{error}</div> : null}
      </div>
    );
  }

  if (props.layout === "empty") {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            {action.pending ? <Spinner size="md" /> : <FolderDownIcon />}
          </EmptyMedia>
          <EmptyTitle>{action.pending ? "Checking out source files…" : copy.label}</EmptyTitle>
          <EmptyDescription>{copy.why}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button
              size="sm"
              disabled={!allowed || action.pending}
              onClick={() => void onCheckOut()}
            >
              Check out
            </Button>
            {howItWorks ? (
              <Button size="sm" variant="ghost-muted" onClick={howItWorks}>
                How it works
              </Button>
            ) : null}
          </div>
          {error ? <div className="text-xs">{error}</div> : null}
        </EmptyContent>
        {explainer.dialog}
      </Empty>
    );
  }

  const suffix = props.context
    ? CONTEXT_SUFFIX[props.context]
    : state === "recovery-required"
      ? "to finish"
      : null;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 px-3 py-2 text-xs text-muted-foreground",
        props.className,
      )}
    >
      <div role="status" className="flex min-w-0 items-start gap-1.5">
        {action.pending ? (
          <Spinner size="sm" className="mt-px shrink-0" />
        ) : (
          <FolderDownIcon aria-hidden className="mt-px size-3.5 shrink-0" />
        )}
        <p className="min-w-0">
          {action.pending ? "Checking out source files…" : copy.line}
          {action.pending ? null : (
            <>
              {/* No-break spaces keep each separator off the start of a wrapped line. */}
              {" · "}
              <InlineButton disabled={!allowed} onClick={() => void onCheckOut()}>
                Check out
              </InlineButton>
              {suffix ? ` ${suffix}` : null}
              {howItWorks ? (
                <>
                  {" · "}
                  <InlineButton tone="muted" onClick={howItWorks}>
                    How it works
                  </InlineButton>
                </>
              ) : null}
            </>
          )}
        </p>
      </div>
      {error}
      {explainer.dialog}
    </div>
  );
}
