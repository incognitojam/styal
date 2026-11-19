import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { FolderDownIcon, TriangleAlertIcon } from "lucide-react";

import { cn } from "~/lib/utils";
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
import { InlineButton } from "./ui/button";
import { Spinner } from "./ui/spinner";

const CONTEXT_SUFFIX = {
  files: "to open tracked files",
  skills: "to use project skills",
} as const;

export function SourceCheckoutNotice(props: {
  environmentId: EnvironmentId;
  cwd: string;
  layout?: "line" | "panel";
  context?: "files" | "skills";
  className?: string;
  onCheckedOut?: () => void;
}) {
  const { environmentId, cwd } = props;
  const status = useEnvironmentQuery(vcsEnvironment.status({ environmentId, input: { cwd } }));
  const action = useAtomValue(gitEnvironment.sourceCheckoutAction({ environmentId, cwd }));
  const allowed = useAtomValue(gitEnvironment.checkOutSources.permissionAtom(environmentId));
  const checkOut = useAtomCommand(gitEnvironment.checkOutSources);
  const state = status.data?.sourceCheckout;
  if (!state) return null;

  const label = action.pending
    ? "Checking out source files…"
    : state === "released"
      ? "Source files released"
      : "Source checkout interrupted";
  const onCheckOut = async () => {
    const result = await checkOut({ environmentId, input: { cwd } });
    status.refresh();
    if (result._tag === "Success") props.onCheckedOut?.();
  };
  const error = action.error ? (
    <div role="alert" className="flex min-w-0 items-start gap-1.5 text-destructive">
      <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 wrap-break-word">{action.error}</span>
    </div>
  ) : null;

  if (props.layout === "panel") {
    return (
      <div className={cn("flex flex-col", props.className)}>
        <div
          role="status"
          className={cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex items-center pe-1")}
        >
          {action.pending ? (
            <Spinner size="md" tone="muted" />
          ) : (
            <FolderDownIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          )}
          <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
            {label}
          </span>
          {action.pending ? null : (
            // The full "Check out again" would truncate the label at the panel's width.
            <ThreadDetailsControl
              part="meta"
              aria-label="Check out source files again"
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

  const suffix = props.context
    ? CONTEXT_SUFFIX[props.context]
    : state === "recovery-required"
      ? "to recover"
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
          {label}
          {action.pending ? null : (
            <>
              {/* The no-break space keeps the separator off the start of a wrapped line. */}
              {"\u00a0· "}
              <InlineButton disabled={!allowed} onClick={() => void onCheckOut()}>
                Check out again
              </InlineButton>
              {suffix ? ` ${suffix}` : null}
            </>
          )}
        </p>
      </div>
      {error}
    </div>
  );
}
