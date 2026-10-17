import { useAtomValue } from "@effect/atom-react";
import {
  fileActionApprovalWarning,
  fileActionCommandChanged,
  fileActionFullyApproved,
  fileActionRolesSentence,
} from "@t3tools/client-runtime/state/projectFileActions";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Fragment, useState } from "react";

import { projectFileActions } from "~/state/projectFileActions";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { reportHardwareResult } from "./hardware/reportHardwareResult";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

export interface FileActionApprovalTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly actionId: string;
}

/** Text with `backticked` spans rendered as code. */
function WithCode({ text }: { text: string }) {
  return text.split("`").map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="font-mono">
        {part}
      </code>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

/**
 * Review of a styal.json action that asks to run on its own. The server
 * reads the command from the project root; approving stores exactly that.
 * `onApproved` runs after a successful approval, for "Approve & run".
 */
export function FileActionApprovalDialog({
  target,
  approveLabel = "Approve",
  onApproved,
  onClose,
}: {
  target: FileActionApprovalTarget | null;
  approveLabel?: string;
  onApproved?: () => void;
  onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    target === null
      ? null
      : projectFileActions.review({
          environmentId: target.environmentId,
          input: { projectId: target.projectId, actionId: target.actionId },
        }),
  );
  const canApprove = useAtomValue(
    projectFileActions.setApproved.permissionAtom(target?.environmentId ?? null),
  );
  const setApproved = useAtomCommand(projectFileActions.setApproved, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const review = query.data;

  const submit = async (approved: boolean) => {
    if (target === null) return;
    setSaving(true);
    const result = await setApproved({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, actionId: target.actionId, approved },
    });
    setSaving(false);
    const ok = reportHardwareResult(
      result,
      approved ? "Could not approve the action" : "Could not revoke the approval",
    );
    if (!ok) return;
    query.refresh();
    onClose();
    if (approved) onApproved?.();
  };

  const fullyApproved = review ? fileActionFullyApproved(review) : false;
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {review ? `Run "${review.name}" automatically?` : "Review action"}
          </DialogTitle>
          <DialogDescription>
            {review
              ? `This action comes from the project's styal.json. ${fileActionRolesSentence(review.roles)}`
              : (query.error ?? "Reading styal.json…")}
          </DialogDescription>
        </DialogHeader>
        {review ? (
          <DialogPanel>
            <div className="flex flex-col gap-3">
              {fileActionCommandChanged(review) && review.approved ? (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">You approved</p>
                  <pre className="overflow-x-auto rounded-md border px-3 py-2 font-mono text-xs text-muted-foreground line-through">
                    {review.approved.command}
                  </pre>
                  <p className="text-xs text-muted-foreground">styal.json now runs</p>
                </div>
              ) : null}
              <pre className="overflow-x-auto rounded-md border px-3 py-2 font-mono text-xs">
                {review.command}
              </pre>
              <p className="text-xs text-muted-foreground">
                <WithCode text={fileActionApprovalWarning(review.hint)} />
              </p>
            </div>
          </DialogPanel>
        ) : null}
        <DialogFooter>
          {fullyApproved ? (
            <Button
              variant="destructive-outline"
              disabled={saving || !canApprove}
              onClick={() => void submit(false)}
            >
              Revoke approval
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            {fullyApproved ? "Close" : "Cancel"}
          </Button>
          {fullyApproved ? null : (
            <Button disabled={saving || !canApprove || !review} onClick={() => void submit(true)}>
              {saving ? "Approving…" : approveLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
