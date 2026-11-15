import { useAtomValue } from "@effect/atom-react";
import {
  type WorktreeCleanupPatternMatches as WorktreeCleanupMatches,
  worktreeCleanupApprovalsFor,
  worktreeCleanupApprovedSelection,
  worktreeCleanupMatchesByPattern,
  worktreeCleanupPatternList,
  worktreeCleanupPathsByPattern,
  worktreeCleanupPatternShape,
  worktreeCleanupPreviewComplete,
  worktreeCleanupPreviewCoverage,
  worktreeCleanupWorkFolders,
  worktreeCleanupResults,
  type WorktreeCleanupNotCleanedReason,
  type WorktreeCleanupPatternList,
  type WorktreeCleanupResultRow,
} from "@t3tools/client-runtime/state/worktreeCleanup";
import type { EnvironmentId, WorktreeCleanupPreview } from "@t3tools/contracts";
import {
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  HistoryIcon,
  TriangleAlertIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";

import { projectConfigRoot, useProjectConfigState } from "../../hooks/useProjectConfig";
import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { worktreeCleanup } from "../../state/worktreeCleanup";
import { reportHardwareResult } from "../hardware/reportHardwareResult";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ForkFeatureBadge, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

interface CleanupCheckout {
  readonly member: SidebarProjectGroupMember;
  readonly environment: EnvironmentPresentation;
  readonly approvals: Readonly<Record<string, { readonly approvedAt: string }>> | undefined;
}

/** The project's `worktreeCleanup` patterns: approval on this machine and a Preview. */
export function WorktreeCleanupPatternsSection() {
  const { scope, targets } = useSettingsScope();
  const { environments } = useEnvironments();
  if (scope.kind !== "project" && scope.kind !== "checkout") return null;
  const memberById = new Map(scope.members.map((member) => [member.id, member]));
  const checkouts = targets.flatMap((target): CleanupCheckout[] => {
    const member = target.projectId ? memberById.get(target.projectId) : undefined;
    const environment = environments.find((entry) => entry.environmentId === target.environmentId);
    const serverConfig = environment?.serverConfig;
    if (!member || !environment || !serverConfig) return [];
    if (serverConfig.environment.capabilities.worktreeCleanupPatterns !== true) return [];
    return [
      {
        member,
        environment,
        approvals: worktreeCleanupApprovalsFor(serverConfig.settings, member),
      },
    ];
  });
  return checkouts.map((checkout) => (
    <CheckoutCleanup
      key={`${checkout.environment.environmentId}:${checkout.member.id}`}
      checkout={checkout}
      showMachine={checkouts.length > 1}
    />
  ));
}

type PreviewState = { readonly preview: WorktreeCleanupPreview } | null;

function CheckoutCleanup({
  checkout,
  showMachine,
}: {
  checkout: CleanupCheckout;
  showMachine: boolean;
}) {
  const { member, environment, approvals } = checkout;
  const environmentId = environment.environmentId;
  const config = useProjectConfigState(environmentId, projectConfigRoot(member)).config;
  const list = worktreeCleanupPatternList(config?.worktreeCleanup, approvals);
  const runPreview = useAtomCommand(worktreeCleanup.preview, { reportFailure: false });
  const canPreview = useAtomValue(worktreeCleanup.preview.permissionAtom(environmentId));
  const [state, setState] = useState<PreviewState>(null);
  const [checking, setChecking] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const running = useRef<AbortController | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops a running preview on the server when the page goes away
  useEffect(() => () => running.current?.abort(), []);

  if (list.pending.length + list.approved.length + list.earlier.length === 0) return null;

  const preview = async () => {
    if (checking) return;
    setChecking(true);
    const controller = new AbortController();
    running.current = controller;
    const result = await runPreview({
      environmentId,
      input: { projectId: member.id, list: "declared", signal: controller.signal },
    });
    if (running.current === controller) running.current = null;
    setChecking(false);
    if (
      reportHardwareResult(result, "Could not preview worktree cleanup") &&
      result._tag === "Success"
    )
      setState({ preview: result.value });
  };
  const openReview = () => {
    setReviewing(true);
    if (state === null && canPreview) void preview();
  };
  const matches: PreviewMatches | null = state
    ? {
        byPattern: worktreeCleanupMatchesByPattern(state.preview),
        complete: worktreeCleanupPreviewComplete(state.preview),
      }
    : null;
  const approved = new Set(list.approved);
  const sectionId = `worktree-cleanup-patterns-${member.id}`;
  const sectionTitle = showMachine
    ? `Regenerable files on ${environment.label}`
    : "Regenerable files";
  const dialog = (
    <ApprovalDialog
      open={reviewing}
      list={list}
      matches={matches}
      pathsByPattern={state ? worktreeCleanupPathsByPattern(state.preview) : null}
      checking={checking}
      environmentId={environmentId}
      projectId={member.id}
      projectName={member.title}
      onClose={() => setReviewing(false)}
    />
  );
  const approveButton =
    list.pending.length > 0 ? (
      <Button size="xs" variant="outline" onClick={openReview}>
        Approve patterns…
      </Button>
    ) : null;
  const checkButton = (
    <Button
      size="xs"
      variant="outline"
      disabled={checking || !canPreview}
      onClick={() => void preview()}
    >
      {checking ? "Checking…" : "Check worktrees"}
    </Button>
  );
  return (
    <SettingsSection
      id={sectionId}
      title={sectionTitle}
      titleAction={<StatusLine list={list} />}
      headerAction={
        <span className="flex items-center gap-1.5">
          {approveButton}
          {checkButton}
        </span>
      }
    >
      <div className="flex flex-col px-3 py-2 sm:px-4">
        <p className="pt-1 pb-2 text-xs text-muted-foreground">
          styal may delete ignored files that match approved patterns from settled worktrees. Check
          worktrees shows what that would delete now.
        </p>
        <PatternList
          list={list}
          matches={matches}
          environmentId={environmentId}
          projectId={member.id}
        />
      </div>
      {state ? (
        <ResultsBody preview={state.preview} approved={approved} />
      ) : checking ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">Checking worktrees…</p>
      ) : !canPreview ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          Checking worktrees lists file names on this machine, so it needs permission to read files
          here.
        </p>
      ) : null}
      {dialog}
    </SettingsSection>
  );
}

function StatusLine({ list }: { list: WorktreeCleanupPatternList }) {
  const pending = list.pending.length;
  const approved = list.approved.length;
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {pending > 0 ? (
        <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
      ) : null}
      {pending > 0
        ? `${pending} ${pending === 1 ? "pattern needs" : "patterns need"} approval${approved > 0 ? ` · ${approved} approved` : ""}`
        : approved === 0
          ? "No patterns in styal.json"
          : `${approved} ${approved === 1 ? "pattern" : "patterns"} approved`}
      <ForkFeatureBadge />
    </span>
  );
}

function PatternList({
  list,
  matches,
  environmentId,
  projectId,
}: {
  list: WorktreeCleanupPatternList;
  matches: PreviewMatches | null;
  environmentId: EnvironmentId;
  projectId: SidebarProjectGroupMember["id"];
}) {
  const canRevoke = useAtomValue(worktreeCleanup.revoke.permissionAtom(environmentId));
  const revoke = useAtomCommand(worktreeCleanup.revoke, { reportFailure: false });
  const revokePattern = async (pattern: string | null) => {
    const result = await revoke({ environmentId, input: { projectId, pattern } });
    reportHardwareResult(result, "Could not revoke the approval");
  };
  return (
    <>
      {[...list.pending, ...list.approved].map((pattern) => (
        <PatternRow
          key={pattern}
          pattern={pattern}
          pending={list.pending.includes(pattern)}
          matches={matches}
          {...(canRevoke ? { onRevoke: () => void revokePattern(pattern) } : {})}
        />
      ))}
      {list.earlier.length > 0 ? (
        <EarlierPatterns
          earlier={list.earlier}
          {...(canRevoke ? { onForget: (pattern: string) => void revokePattern(pattern) } : {})}
        />
      ) : null}
      {canRevoke && list.approved.length + list.earlier.length > 0 ? (
        <div className="flex justify-end pt-2">
          <Button size="xs" variant="destructive-outline" onClick={() => void revokePattern(null)}>
            Revoke all
          </Button>
        </div>
      ) : null}
    </>
  );
}

const rowClass = "flex min-h-8 flex-wrap items-center gap-x-3 gap-y-0.5";

function IconAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: "revoke" | "forget";
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="icon-xs" variant="ghost-muted" aria-label={label} onClick={onClick}>
            {icon === "revoke" ? <Undo2Icon /> : <XIcon />}
          </Button>
        }
      />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

interface PreviewMatches {
  readonly byPattern: ReadonlyMap<string, WorktreeCleanupMatches>;
  /** False when part of the preview was not checked, so "no match" is unknown. */
  readonly complete: boolean;
}

function matchText(matches: PreviewMatches, pattern: string) {
  const found = matches.byPattern.get(pattern);
  if (!found) return matches.complete ? "Matches nothing right now" : "Not fully checked";
  const noun =
    found.kind === "file"
      ? found.count === 1
        ? "file"
        : "files"
      : found.kind === "directory"
        ? found.count === 1
          ? "folder"
          : "folders"
        : found.count === 1
          ? "item"
          : "items";
  return `${found.count} ${noun} in ${found.worktrees} ${found.worktrees === 1 ? "worktree" : "worktrees"} · ${found.incomplete ? "at least " : ""}${formatBytes(found.bytes)}`;
}

/** One pattern, drawn like the files or folders it deletes. */
function PatternRow({
  pattern,
  pending,
  matches,
  onRevoke,
}: {
  pattern: string;
  pending: boolean;
  matches: PreviewMatches | null;
  onRevoke?: () => void;
}) {
  const found = matches?.byPattern.get(pattern);
  const kind = found ? found.kind : worktreeCleanupPatternShape(pattern);
  const Glyph = kind === "file" ? FileIcon : FolderIcon;
  return (
    <div className={rowClass}>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <Glyph
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground",
            matches && !found && "opacity-50",
          )}
        />
        <code className="min-w-0 font-mono text-xs break-all select-text">{pattern}</code>
        {pending ? (
          <Badge size="sm" variant="warning">
            Needs approval
          </Badge>
        ) : null}
      </span>
      {matches ? (
        <span
          className={cn(
            "text-xs text-muted-foreground tabular-nums",
            !found && "italic opacity-80",
          )}
        >
          {matchText(matches, pattern)}
        </span>
      ) : null}
      {!pending && onRevoke ? (
        <IconAction label={`Revoke approval for ${pattern}`} icon="revoke" onClick={onRevoke} />
      ) : (
        <span aria-hidden className="size-6" />
      )}
    </div>
  );
}

const approvedDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

function EarlierPatterns({
  earlier,
  onForget,
}: {
  earlier: WorktreeCleanupPatternList["earlier"];
  onForget?: (pattern: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="mt-1 flex min-h-8 w-full items-center gap-1.5 rounded-md text-left text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        {earlier.length} approved earlier, not in styal.json
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <p className="pb-1 pl-5 text-xs text-muted-foreground">
          {earlier.length === 1 ? "It applies" : "They apply"} again without asking if styal.json
          lists {earlier.length === 1 ? "it" : "them"}.
        </p>
        <div className="pl-5">
          {earlier.map(({ pattern, approvedAt }) => (
            <div key={pattern} className={rowClass}>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <HistoryIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <code className="min-w-0 truncate font-mono text-xs text-muted-foreground select-text">
                  {pattern}
                </code>
              </span>
              <span className="text-xs text-muted-foreground">
                Approved {approvedDate(approvedAt)}
              </span>
              {onForget ? (
                <IconAction
                  label={`Forget ${pattern}`}
                  icon="forget"
                  onClick={() => onForget(pattern)}
                />
              ) : (
                <span aria-hidden className="size-6" />
              )}
            </div>
          ))}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

const NOT_CLEANED_LABEL: Record<WorktreeCleanupNotCleanedReason, string> = {
  "frees-nothing": "Frees nothing",
  "nothing-matched": "Nothing matched",
  "not-settled": "Not settled",
  missing: "Folder missing",
  "symbolic-link": "Symbolic link",
  "not-managed": "Not a styal worktree",
  "too-large": "Too many files to check",
  "not-fully-checked": "Not fully checked",
  "not-reached": "Not reached",
};

function notCleanedTitle(row: WorktreeCleanupResultRow) {
  switch (row.reason) {
    case "frees-nothing":
      return "Its files share disk space with other files, such as a pnpm store, so deleting them frees nothing.";
    case "not-fully-checked":
      return "The check stopped before it reached everything in this worktree.";
    case "not-reached":
      return "The check ran out of time before it reached this worktree.";
    case "not-settled":
      return row.entry.holdingThread
        ? `“${row.entry.holdingThread.title}” has not settled.`
        : "A thread in this worktree has not settled.";
    default:
      return undefined;
  }
}

function NotCleanedValue({ row }: { row: WorktreeCleanupResultRow }) {
  if (row.reason === null)
    return (
      <span className="tabular-nums">
        {row.incomplete ? "at least " : ""}
        {formatBytes(row.freedBytes)}
      </span>
    );
  const label = <span className="text-muted-foreground">{NOT_CLEANED_LABEL[row.reason]}</span>;
  const explanation = notCleanedTitle(row);
  if (explanation === undefined) return label;
  return (
    <Tooltip>
      <TooltipTrigger render={label} />
      <TooltipPopup>{explanation}</TooltipPopup>
    </Tooltip>
  );
}

function folderName(path: string) {
  return path.split(/[\\/]/).findLast(Boolean) ?? path;
}

function ResultsBody({
  preview,
  approved,
}: {
  preview: WorktreeCleanupPreview;
  approved: ReadonlySet<string>;
}) {
  const results = worktreeCleanupResults(preview, approved);
  const coverage = worktreeCleanupPreviewCoverage(preview);
  return (
    <div>
      <div className="max-h-[26rem] overflow-y-auto px-1 sm:px-2">
        <ResultTable
          rows={[...results.cleaned, ...results.notCleaned]}
          approved={approved}
          total={`${results.incomplete ? "at least " : ""}${formatBytes(results.totalBytes)}`}
        />
      </div>
      {coverage ? (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground sm:px-4">{coverage}</p>
      ) : null}
    </div>
  );
}

const KEPT_LABEL = {
  "not-ignored": "kept: git does not ignore it",
  "contains-tracked-files": "kept: contains files git tracks or does not ignore",
  "symbolic-link": "kept: symbolic link",
  "mount-point": "kept: another file system is mounted there",
  "nested-checkout": "kept: contains a git repository",
  "too-large-to-verify": "kept: too many files to check",
} as const;

function ResultTable({
  rows,
  approved,
  total,
}: {
  rows: readonly WorktreeCleanupResultRow[];
  approved: ReadonlySet<string>;
  total: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Worktree ({rows.length})</TableHead>
          <TableHead className="text-right">Would free ({total})</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const { entry } = row;
          const selected = worktreeCleanupApprovedSelection(entry, approved);
          const canExpand = selected.length + entry.kept.length > 0 || entry.entriesTruncated;
          const expanded = open === entry.worktreePath;
          return (
            <Fragment key={entry.worktreePath}>
              <TableRow>
                <TableCell>
                  {canExpand ? (
                    <button
                      type="button"
                      aria-expanded={expanded}
                      className={cn(
                        "flex items-center gap-1 rounded-sm font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                        row.reason !== null && "text-muted-foreground",
                      )}
                      onClick={() => setOpen(expanded ? null : entry.worktreePath)}
                    >
                      <ChevronRightIcon
                        aria-hidden
                        className={cn(
                          "size-3.5 shrink-0 text-muted-foreground transition-transform",
                          expanded && "rotate-90",
                        )}
                      />
                      {folderName(entry.worktreePath)}
                    </button>
                  ) : (
                    <span
                      className={cn(
                        "flex items-center gap-1 pl-4.5 font-mono",
                        row.reason !== null && "text-muted-foreground",
                      )}
                    >
                      {folderName(entry.worktreePath)}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <NotCleanedValue row={row} />
                </TableCell>
              </TableRow>
              {expanded ? (
                <TableRow>
                  <TableCell colSpan={2}>
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-0.5 py-1 pl-5 text-muted-foreground">
                      {selected.map((item) => (
                        <Fragment key={item.path}>
                          <code className="truncate text-foreground/80 select-text">
                            {item.path}
                          </code>
                          <span className="text-right tabular-nums">
                            {item.freedBytes === null
                              ? "Not measured"
                              : formatBytes(item.freedBytes)}
                          </span>
                        </Fragment>
                      ))}
                      {entry.kept.map((kept) => (
                        <Fragment key={kept.path}>
                          <span className="truncate">
                            <code className="text-foreground/80 select-text">{kept.path}</code>{" "}
                            {KEPT_LABEL[kept.reason]}
                            {kept.detail ? ` (${kept.detail})` : ""}
                          </span>
                          <span />
                        </Fragment>
                      ))}
                      {entry.entriesTruncated ? (
                        <span className="col-span-2">
                          More paths matched than are listed here, so the size is a lower bound.
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

function ApprovalDialog({
  open,
  list,
  matches,
  pathsByPattern,
  checking,
  environmentId,
  projectId,
  projectName,
  onClose,
}: {
  open: boolean;
  list: WorktreeCleanupPatternList;
  matches: PreviewMatches | null;
  pathsByPattern: ReadonlyMap<string, readonly string[]> | null;
  checking: boolean;
  environmentId: EnvironmentId;
  projectId: SidebarProjectGroupMember["id"];
  projectName: string;
  onClose: () => void;
}) {
  const canApprove = useAtomValue(worktreeCleanup.approve.permissionAtom(environmentId));
  const approve = useAtomCommand(worktreeCleanup.approve, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const pending = list.pending;
  const submit = async () => {
    setSaving(true);
    const result = await approve({ environmentId, input: { projectId, patterns: [...pending] } });
    setSaving(false);
    if (!reportHardwareResult(result, "Could not approve the patterns")) return;
    if (result._tag === "Success" && result.value.notDeclared.length > 0) {
      toastManager.add({
        type: "warning",
        title:
          result.value.notDeclared.length === 1
            ? "One pattern was not approved"
            : `${result.value.notDeclared.length} patterns were not approved`,
        description: "styal.json no longer lists them. Review the list again.",
      });
    }
    onClose();
  };
  const workFolders = [
    ...new Set(
      pending.flatMap((pattern) =>
        worktreeCleanupWorkFolders(pattern, pathsByPattern?.get(pattern) ?? []),
      ),
    ),
  ];
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {pending.length === 1 ? "Approve pattern?" : "Approve patterns?"}
          </DialogTitle>
          <DialogDescription>
            Once approved on this machine, styal may delete ignored files matching{" "}
            {pending.length === 1 ? "this pattern" : "these patterns"} from {projectName}'s
            worktrees after every thread in them has settled.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <div className="divide-y rounded-md border text-xs">
              <div className="flex justify-between gap-3 px-3 py-1.5 text-muted-foreground">
                <span>Pattern</span>
                <span>Would delete now</span>
              </div>
              {pending.map((pattern) => (
                <div key={pattern} className="flex items-start justify-between gap-3 px-3 py-2">
                  <code className="min-w-0 font-mono break-all select-text">{pattern}</code>
                  <span className="shrink-0 text-right text-muted-foreground tabular-nums">
                    {matches ? matchText(matches, pattern) : checking ? "Checking…" : "Not checked"}
                  </span>
                </div>
              ))}
            </div>
            <p className="flex gap-1.5 text-xs text-warning-foreground">
              <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0 text-warning" />
              Matching files will be deleted from settled worktrees and cannot be restored. The
              project's setup or build is expected to recreate them.
            </p>
            {workFolders.length > 0 ? (
              <p className="text-xs text-warning-foreground">
                {workFolders.map((folder, index) => (
                  <Fragment key={folder}>
                    {index > 0 ? " and " : ""}
                    <code>{folder}</code>
                  </Fragment>
                ))}{" "}
                {workFolders.length === 1 ? "often holds" : "often hold"} notes and work in
                progress, not build output. Approve only if nothing there needs keeping.
              </p>
            ) : null}
            {list.approved.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Already approved:{" "}
                {list.approved.map((pattern, index) => (
                  <Fragment key={pattern}>
                    {index > 0 ? ", " : ""}
                    <code>{pattern}</code>
                  </Fragment>
                ))}
                .
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={saving || !canApprove || pending.length === 0}
            onClick={() => void submit()}
          >
            {saving
              ? "Approving…"
              : pending.length === 1
                ? "Approve pattern"
                : `Approve ${pending.length} patterns`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
