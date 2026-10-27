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
import { CONTENT_UPDATE_CLICK_GUARD_MS } from "../../confirmDialog";
import { HostActivityThreadList } from "../HostActivityThreadList";
import { StableLabel } from "../StableLabel";
import { Spinner } from "../ui/spinner";
import type { SkippedMachine, UpdateEverythingConfirmation } from "./updateEverything.logic";

interface UpdateEverythingDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly summary: string;
  readonly lines: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<SkippedMachine>;
  readonly activity: UpdateEverythingConfirmation;
  /** The running-work check is still going, so confirming skips it. */
  readonly checking: boolean;
  /** When a late check result replaced the content; clicks just after it are ignored. */
  readonly contentUpdatedAt?: number | null;
  readonly onConfirm: () => void;
}

export function UpdateEverythingDialog({
  open,
  onOpenChange,
  summary,
  lines,
  skipped,
  activity,
  checking,
  contentUpdatedAt = null,
  onConfirm,
}: UpdateEverythingDialogProps) {
  const reportDecision = useCombinedUpdateConfirmationUsage(open);
  const hasThreads = activity.threadActivity.length > 0;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) reportDecision("cancelled");
        onOpenChange(nextOpen);
      }}
    >
      {/* Refocusing the trigger after a pointer close shows its focus ring and opens its tooltip. */}
      <AlertDialogPopup finalFocus={(closeType) => closeType === "keyboard"}>
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
            {activity.lines.length > 0 ? (
              <div className="flex items-start gap-2 pt-2">
                {checking ? (
                  <span className="pt-0.5">
                    <Spinner size="sm" tone="muted" aria-label="Checking" />
                  </span>
                ) : null}
                <p className="whitespace-pre-line text-sm">{activity.lines.join("\n")}</p>
              </div>
            ) : null}
            {skipped.length > 0 ? (
              <p className="whitespace-pre-line pt-2 text-sm">
                {skipped.map((machine) => `Skips ${machine.label}: ${machine.reason}`).join("\n")}
              </p>
            ) : null}
          </AlertDialogHeader>
        </div>
        {hasThreads ? <HostActivityThreadList activity={activity.threadActivity} /> : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            onClick={() => {
              if (
                contentUpdatedAt !== null &&
                Date.now() - contentUpdatedAt < CONTENT_UPDATE_CLICK_GUARD_MS
              )
                return;
              reportDecision("confirmed");
              onConfirm();
            }}
          >
            <StableLabel
              label={checking ? "Update anyway" : "Update"}
              previous={contentUpdatedAt === null ? undefined : "Update anyway"}
            />
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
