import { msg, T, useMessages } from "gt-react";
import type { ConfirmDialogThreadActivity } from "@t3tools/contracts";
import { useEnvironmentMachines } from "~/state/environments";
import { CONTENT_UPDATE_CLICK_GUARD_MS } from "../../confirmDialog";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { HostActivityThreadList } from "../HostActivityThreadList";
import { StableLabel } from "../StableLabel";
import { Spinner } from "../ui/spinner";
import { ChevronRightIcon } from "lucide-react";
import { Fragment, type RefObject, useRef } from "react";

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
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ScrollArea } from "../ui/scroll-area";
import type { UpdateEverythingConfirmation, UpdateEverythingRow } from "./updateEverything.logic";

interface UpdateEverythingDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly version: string | null;
  readonly providerCount: number;
  readonly rows: ReadonlyArray<UpdateEverythingRow>;
  readonly activity: UpdateEverythingConfirmation;
  readonly checking: boolean;
  readonly contentUpdatedAt?: number | null;
  readonly onConfirm: () => void;
  /** Overrides the default title, for an update-track switch. */
  readonly title?: string;
  readonly confirmLabel?: string;
  readonly notes?: ReadonlyArray<string>;
  /** Disables the confirm button and says why. */
  readonly disabledReason?: string | null;
  /** The confirmed work is starting; it cannot be cancelled from here. */
  readonly busy?: boolean;
  /** Machines are still looking for provider updates, so more rows can appear. */
  readonly checkingProviders?: boolean;
}

type UpdateEverythingDialogContentProps = Omit<
  UpdateEverythingDialogProps,
  "open" | "onOpenChange"
> & {
  readonly cancelRef: RefObject<HTMLButtonElement | null>;
};

export function UpdateEverythingDialog({
  open,
  onOpenChange,
  ...content
}: UpdateEverythingDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
      }}
    >
      {/* Refocusing the trigger after a pointer close shows its focus ring and opens its tooltip. */}
      <AlertDialogPopup
        className="sm:max-w-xl"
        initialFocus={cancelRef}
        finalFocus={(closeType) => closeType === "keyboard"}
      >
        <UpdateEverythingDialogContent
          {...content}
          cancelRef={cancelRef}
          onConfirm={() => {
            if (
              content.contentUpdatedAt != null &&
              Date.now() - content.contentUpdatedAt < CONTENT_UPDATE_CLICK_GUARD_MS
            )
              return;
            content.onConfirm();
          }}
        />
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function UpdateEverythingDialogContent({
  version,
  providerCount,
  rows,
  activity,
  checking,
  contentUpdatedAt = null,
  onConfirm,
  cancelRef,
  title,
  confirmLabel,
  notes = [],
  disabledReason = null,
  busy = false,
  checkingProviders = false,
}: UpdateEverythingDialogContentProps) {
  const m = useMessages();
  const machines = useEnvironmentMachines();
  const updating = rows
    .filter((row) => row.app !== null || row.providers.length > 0)
    .toSorted((a, b) => Number(a.app === "this-app") - Number(b.app === "this-app"));
  const skipped = rows.filter((row) => row.skipped !== null);
  const restartsAll = updating.length > 0 && updating.every((row) => row.app !== null);
  // Provider installs and server handoffs run in no fixed order; only this app waits for the rest.
  const othersUpdate = updating.some((row) => row.app !== "this-app");
  // Older servers report no environment id, only the label this client gave their check.
  const belongsTo = (item: ConfirmDialogThreadActivity, row: UpdateEverythingRow) =>
    item.environmentId === undefined
      ? item.hostLabel === row.label
      : item.environmentId === row.environmentId;
  const otherActivity = activity.threadActivity.filter(
    (item) => !updating.some((row) => belongsTo(item, row)),
  );

  return (
    <>
      <AlertDialogHeader className="shrink-0">
        <AlertDialogTitle>
          {title ??
            m(
              restartsAll
                ? msg(
                    "{count, plural, one {Update and restart {count} machine?} other {Update and restart {count} machines?}}",
                    { count: updating.length },
                  )
                : msg(
                    "{count, plural, one {Update {count} machine?} other {Update {count} machines?}}",
                    { count: updating.length },
                  ),
            )}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {version !== null ? (
            <>
              styal <span className="font-mono text-xs">{version}</span>
            </>
          ) : null}
          {version !== null && providerCount > 0 ? " · " : null}
          {providerCount > 0
            ? m(
                msg(
                  "{count, plural, one {{count} provider update} other {{count} provider updates}}",
                  { count: providerCount },
                ),
              )
            : null}
          {checkingProviders
            ? `${version !== null || providerCount > 0 ? " · " : ""}${m(msg("Checking for more…"))}`
            : null}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <ScrollArea scrollFade>
        <div className="flex flex-col gap-6 px-6 pb-4">
          {notes.map((note) => (
            <p key={note} className="text-muted-foreground text-sm">
              {note}
            </p>
          ))}
          {updating.map((row) => {
            const note =
              row.app === "this-app" && othersUpdate
                ? m(msg("Restarts last"))
                : row.app !== null
                  ? null
                  : row.skipped !== null
                    ? m(msg("styal skipped"))
                    : m(msg("No restart"));
            return (
              <section
                aria-label={row.label}
                key={row.environmentId ?? "this-app"}
                className="min-w-0 text-sm"
              >
                <div className="flex items-center gap-2">
                  <EnvironmentMachineIcon
                    aria-hidden
                    kind={
                      (row.environmentId && machines.get(row.environmentId)) ||
                      (row.app === "this-app" ? "desktop" : "server")
                    }
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <h3 className="flex min-w-0 font-semibold text-foreground">
                    <MiddleTruncate value={row.label} />
                  </h3>
                  {note !== null ? (
                    <span className="ms-auto shrink-0 text-muted-foreground text-xs">{note}</span>
                  ) : null}
                </div>
                {row.providers.length > 0 ? (
                  <p className="mt-1 text-muted-foreground text-xs">
                    <T>Updates</T>{" "}
                    {row.providers.map((provider, index) => (
                      <Fragment key={provider}>
                        <span className="whitespace-nowrap">{provider}</span>
                        {index < row.providers.length - 1 ? ", " : null}
                      </Fragment>
                    ))}
                  </p>
                ) : null}
                {activity.threadActivity.some((item) => belongsTo(item, row)) ? (
                  <HostActivityThreadList
                    withinMachine
                    activity={activity.threadActivity.filter((item) => belongsTo(item, row))}
                  />
                ) : null}
              </section>
            );
          })}
          {skipped.length > 0 ? (
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground data-panel-open:[&_svg]:rotate-90">
                <ChevronRightIcon className="size-3.5 transition-transform" aria-hidden />
                {m(
                  msg("{count, plural, one {{count} skipped} other {{count} skipped}}", {
                    count: skipped.length,
                  }),
                )}
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div className="grid grid-cols-[minmax(0,max-content)_1fr] gap-x-3 gap-y-0.5 pt-1.5 ps-4.5 text-muted-foreground text-xs">
                  {skipped.map((row) => (
                    <Fragment key={row.environmentId ?? "this-app"}>
                      <span className="max-w-32 min-w-0">
                        <MiddleTruncate value={row.label} />
                      </span>
                      <span className="wrap-anywhere">{row.skipped}</span>
                    </Fragment>
                  ))}
                </div>
              </CollapsiblePanel>
            </Collapsible>
          ) : null}
        </div>
        {activity.lines.length > 0 ? (
          <div className="flex items-start gap-2 px-6 pb-3">
            {checking ? <Spinner size="sm" tone="muted" aria-label={m(msg("Checking"))} /> : null}
            <p className="whitespace-pre-line text-sm">{activity.lines.join("\n")}</p>
          </div>
        ) : null}
        {otherActivity.length > 0 ? <HostActivityThreadList activity={otherActivity} /> : null}
      </ScrollArea>
      <AlertDialogFooter>
        {disabledReason !== null ? (
          <p className="self-center text-sm max-sm:order-1 max-sm:text-center sm:mr-auto">
            {disabledReason}
          </p>
        ) : null}
        <AlertDialogClose ref={cancelRef} render={<Button variant="outline" disabled={busy} />}>
          <T>Cancel</T>
        </AlertDialogClose>
        <Button disabled={disabledReason !== null || busy} onClick={onConfirm}>
          {confirmLabel ?? (
            <StableLabel
              label={
                checking
                  ? m(msg("Update anyway"))
                  : restartsAll
                    ? m(msg("Update and restart"))
                    : m(msg("Update"))
              }
              previous={contentUpdatedAt === null ? undefined : m(msg("Update anyway"))}
            />
          )}
        </Button>
      </AlertDialogFooter>
    </>
  );
}
