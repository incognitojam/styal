import { MessageCircle, Pencil, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

import { isCommentSubmitShortcut } from "./commentSubmitShortcut";

interface DiffCommentSecondaryAction {
  readonly label: string;
  readonly icon?: ReactNode;
  readonly allowEmpty?: boolean;
  readonly onAction: (text: string) => void;
}

interface DiffCommentEditState {
  readonly active: boolean;
  readonly text: string;
  readonly onStart: () => void;
  readonly onChange: (text: string) => void;
  readonly onCancel: () => void;
  readonly onSave: (text: string) => void;
}

interface DiffCommentAnnotationProps {
  kind: "draft" | "comment";
  rangeLabel: string;
  text: string;
  onTextChange?: (text: string) => void;
  onCancel: () => void;
  onComment: (text: string) => void;
  edit?: DiffCommentEditState;
  onDelete?: () => void;
  placeholder?: string;
  submitLabel?: string;
  pending?: boolean;
  secondaryAction?: DiffCommentSecondaryAction;
}

/** The shared inline comment treatment for file previews, thread diffs, and pull-request diffs. */
export function DiffCommentAnnotation({
  kind,
  rangeLabel,
  text,
  onTextChange,
  onCancel,
  onComment,
  edit,
  onDelete,
  placeholder = "Add a comment…",
  submitLabel = "Comment",
  pending = false,
  secondaryAction,
}: DiffCommentAnnotationProps) {
  const [localDraftText, setLocalDraftText] = useState("");
  const isEditingComment = kind === "comment" && edit?.active === true;
  const displayedText = isEditingComment
    ? edit.text
    : kind === "draft" && !onTextChange
      ? localDraftText
      : text;
  const trimmedText = displayedText.trim();
  const submit = () => {
    if (isEditingComment) {
      edit.onSave(trimmedText);
    } else {
      onComment(trimmedText);
    }
  };

  if (kind === "comment" && !isEditingComment) {
    return (
      <div
        data-diff-comment-annotation
        className="group/comment flex min-w-0 items-start gap-2.5 border-s-2 border-primary/55 bg-primary/[0.045] px-3 py-2.5 font-sans text-foreground"
        contentEditable={false}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <MessageCircle className="mt-0.5 size-3.5 shrink-0 text-primary/70" aria-hidden="true" />
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-[13px] leading-5">{displayedText}</p>
        {edit || onDelete ? (
          <div className="-my-1 -mr-1 flex shrink-0 items-center opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
            {edit ? (
              <Button
                className="text-muted-foreground"
                variant="ghost"
                size="icon-xs"
                aria-label="Edit comment"
                onClick={edit.onStart}
              >
                <Pencil className="size-3" />
              </Button>
            ) : null}
            {onDelete ? (
              <Button
                className="text-muted-foreground"
                variant="ghost"
                size="icon-xs"
                aria-label="Delete comment"
                onClick={onDelete}
              >
                <Trash2 className="size-3" />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-diff-comment-annotation
      className="px-3 py-2 font-sans text-foreground"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Textarea
        autoFocus
        unstyled
        className="relative inline-flex w-full rounded-md border border-border/50 bg-background/20 font-sans text-foreground transition-colors focus-within:border-border/70 [&_[data-slot=textarea]]:min-h-12 [&_[data-slot=textarea]]:cursor-text [&_[data-slot=textarea]]:px-2.5 [&_[data-slot=textarea]]:py-1.5 [&_[data-slot=textarea]]:font-sans [&_[data-slot=textarea]]:text-xs [&_[data-slot=textarea]]:leading-5 max-sm:[&_[data-slot=textarea]]:min-h-12"
        size="sm"
        value={displayedText}
        placeholder={placeholder}
        aria-label={`${isEditingComment ? "Edit comment" : "Comment"} on lines ${rangeLabel}`}
        onChange={(event) =>
          (isEditingComment ? edit.onChange : (onTextChange ?? setLocalDraftText))(
            event.target.value,
          )
        }
        onFocus={(event) => {
          const end = event.currentTarget.value.length;
          event.currentTarget.setSelectionRange(end, end);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            if (isEditingComment) {
              edit.onCancel();
            } else {
              onCancel();
            }
          }
          if (isCommentSubmitShortcut(event, trimmedText, pending)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="mt-1.5 flex items-center gap-1">
        <span className="mr-auto text-[10px] text-muted-foreground/70">
          ⌘/Ctrl Enter to {isEditingComment ? "save" : "send"}
        </span>
        <Button
          className="text-muted-foreground hover:text-foreground"
          variant="ghost"
          size="xs"
          onClick={() => {
            if (isEditingComment) {
              edit.onCancel();
            } else {
              onCancel();
            }
          }}
        >
          Cancel
        </Button>
        {secondaryAction ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!secondaryAction.allowEmpty && !trimmedText}
            onClick={() => secondaryAction.onAction(trimmedText)}
          >
            {secondaryAction.icon}
            {secondaryAction.label}
          </Button>
        ) : null}
        <Button size="xs" disabled={pending || !trimmedText} onClick={submit}>
          {isEditingComment ? "Save" : submitLabel}
        </Button>
      </div>
    </div>
  );
}
