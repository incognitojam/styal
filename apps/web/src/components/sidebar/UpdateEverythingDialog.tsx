import { useCombinedUpdateConfirmationUsage } from "../../combinedUpdateConfirmationUsage";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { HostActivityThreadList } from "../HostActivityThreadList";
import { Spinner } from "../ui/spinner";
import type { SkippedMachine, UpdateEverythingConfirmation } from "./updateEverything.logic";

interface UpdateEverythingDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly summary: string;
  readonly lines: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<SkippedMachine>;
  readonly activity: UpdateEverythingConfirmation | null;
  readonly onConfirm: () => void;
}

export function UpdateEverythingDialog({
  open,
  onOpenChange,
  summary,
  lines,
  skipped,
  activity,
  onConfirm,
}: UpdateEverythingDialogProps) {
  const reportDecision = useCombinedUpdateConfirmationUsage(open && activity !== null);
  const hasThreads = (activity?.threadActivity.length ?? 0) > 0;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) reportDecision("cancelled");
        onOpenChange(nextOpen);
      }}
    >
      <AlertDialogPopup>
        <div
          className={
            hasThreads ? "max-h-[40dvh] shrink-0 overflow-y-auto" : "min-h-0 overflow-y-auto"
          }
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{summary}?</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line">
              {lines.join("\n")}
            </AlertDialogDescription>
            {activity === null ? (
              <div className="flex items-center gap-2 pt-2" role="status">
                <Spinner size="sm" tone="muted" />
                <p className="text-sm">Checking for running work…</p>
              </div>
            ) : activity.lines.length > 0 ? (
              <p className="whitespace-pre-line pt-2 text-sm">{activity.lines.join("\n")}</p>
            ) : null}
            {skipped.length > 0 ? (
              <p className="whitespace-pre-line pt-2 text-sm">
                {skipped.map((machine) => `Skips ${machine.label}: ${machine.reason}`).join("\n")}
              </p>
            ) : null}
          </AlertDialogHeader>
        </div>
        {hasThreads ? <HostActivityThreadList activity={activity!.threadActivity} /> : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            disabled={activity === null}
            onClick={() => {
              reportDecision("confirmed");
              onConfirm();
            }}
          >
            Update
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
