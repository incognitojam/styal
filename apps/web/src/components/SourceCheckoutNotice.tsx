import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { gitEnvironment } from "~/state/git";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { StyalToolIcon } from "./StyalToolIcon";
import { Button } from "./ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";

export function SourceCheckoutNotice(props: {
  environmentId: EnvironmentId;
  cwd: string;
  context?: "files" | "skills";
  onCheckedOut?: () => void;
}) {
  const { environmentId, cwd } = props;
  const status = useEnvironmentQuery(vcsEnvironment.status({ environmentId, input: { cwd } }));
  const action = useAtomValue(gitEnvironment.sourceCheckoutAction({ environmentId, cwd }));
  const allowed = useAtomValue(gitEnvironment.checkOutSources.permissionAtom(environmentId));
  const checkOut = useAtomCommand(gitEnvironment.checkOutSources);
  if (!status.data?.sourceCheckout) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs" role="status">
      <Tooltip>
        <TooltipTrigger render={<span aria-label="Only in styal" />}>
          <StyalToolIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>Only in styal</TooltipPopup>
      </Tooltip>
      <span>
        {action.pending
          ? "Checking out source files…"
          : status.data.sourceCheckout === "released"
            ? "Source files released"
            : "Source checkout interrupted"}
      </span>
      <Button
        size="compact"
        variant="outline"
        disabled={!allowed || action.pending}
        onClick={async () => {
          const result = await checkOut({ environmentId, input: { cwd } });
          status.refresh();
          if (result._tag === "Success") props.onCheckedOut?.();
        }}
      >
        {action.pending ? "Checking out…" : "Check out again"}
      </Button>
      {props.context ? (
        <span className="w-full text-muted-foreground">
          {props.context === "skills"
            ? "Project skills are available after checking out source files."
            : "Check out again to open tracked source files."}
        </span>
      ) : null}
      {!action.pending && status.data?.sourceCheckout === "recovery-required" ? (
        <span className="w-full text-muted-foreground">
          Source checkout was interrupted. Check out again to recover.
        </span>
      ) : null}
      {action.error ? (
        <span className="w-full text-destructive" role="alert">
          {action.error}
        </span>
      ) : null}
    </div>
  );
}
