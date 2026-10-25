import type { EnvironmentId, ThreadId, ThreadWorkflowRunWatch } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { CheckIcon, ExternalLinkIcon, ShieldQuestionIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { ComposerBanner } from "./ComposerBanner";

type ReviewState = "approved" | "rejected";

const OPTIONS: ReadonlyArray<{ readonly state: ReviewState; readonly label: string }> = [
  { state: "approved", label: "Approve and deploy" },
  { state: "rejected", label: "Reject" },
];

/**
 * The deployment review a watched workflow run waits on, in the slot above the composer that
 * questions use. Choosing an option only selects it: a deployment is reviewed on Submit, never
 * by a single click or key.
 */
export function WorkflowRunReviewPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runs: ReadonlyArray<ThreadWorkflowRunWatch>;
}) {
  const reviewed = props.runs.filter((run) => run.review !== undefined);
  const run = reviewed[0];
  if (run?.review === undefined) return null;
  const key = `${run.host}/${run.repository}/${run.runId}`;
  return (
    <WorkflowRunReviewForm
      // A new run, or a new set of waiting environments, starts a fresh form.
      key={`${key}:${run.review.environments.map((environment) => environment.id).join(",")}`}
      environmentId={props.environmentId}
      threadId={props.threadId}
      run={run}
      environments={run.review.environments}
      waitingCount={reviewed.length}
    />
  );
}

function WorkflowRunReviewForm(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly run: ThreadWorkflowRunWatch;
  readonly environments: NonNullable<ThreadWorkflowRunWatch["review"]>["environments"];
  readonly waitingCount: number;
}) {
  const { run, environments } = props;
  const canReview = useAtomValue(
    pullRequestEnvironment.reviewWorkflowRun.permissionAtom(props.environmentId),
  );
  const review = useAtomCommand(pullRequestEnvironment.reviewWorkflowRun, {
    reportFailure: false,
  });
  const [selectedEnvironments, setSelectedEnvironments] = useState<ReadonlySet<number>>(
    () => new Set(environments.map((environment) => environment.id)),
  );
  const [choice, setChoice] = useState<ReviewState | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const [first, ...rest] = environments
      .map((environment) => environment.id)
      .filter((id) => selectedEnvironments.has(id));
    if (choice === null || first === undefined || submitting) return;
    setSubmitting(true);
    const result = await review({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        host: run.host,
        repository: run.repository,
        runId: run.runId,
        environmentIds: [first, ...rest],
        state: choice,
        comment: comment.trim(),
      },
    });
    setSubmitting(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title:
          choice === "approved" ? "Could not approve deployment" : "Could not reject deployment",
        description: readableFailure(
          squashAtomCommandFailure(result),
          "Review it on GitHub instead.",
        ),
      });
    }
  }

  const locked = !canReview || submitting;
  return (
    <>
      <ComposerBanner.Row>
        <ComposerBanner.Icon>
          <ShieldQuestionIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content>
          <span className="shrink-0 font-medium text-muted-foreground">Deployment review</span>
          <span className="min-w-0 truncate">{run.name}</span>
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          {props.waitingCount > 1 ? (
            <span className="text-3xs font-medium text-muted-foreground tabular-nums">
              1/{props.waitingCount}
            </span>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Open on GitHub"
            render={<a href={run.url} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon />
          </Button>
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      <ComposerBanner.Body className="pe-1 pb-1">
        <p className="text-foreground/85">
          Waiting for your review to deploy to{" "}
          {environments.map((environment) => environment.name).join(", ")}.
        </p>
        {environments.length > 1 ? (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {environments.map((environment) => (
              <label key={environment.id} className="flex items-center gap-1.5">
                <Checkbox
                  checked={selectedEnvironments.has(environment.id)}
                  disabled={locked}
                  onCheckedChange={(checked) =>
                    setSelectedEnvironments((current) => {
                      const next = new Set(current);
                      if (checked) next.add(environment.id);
                      else next.delete(environment.id);
                      return next;
                    })
                  }
                />
                {environment.name}
              </label>
            ))}
          </div>
        ) : null}
        <div role="radiogroup" aria-label="Review" className="mt-2 space-y-0.5">
          {OPTIONS.map((option) => {
            const selected = choice === option.state;
            return (
              <button
                key={option.state}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={locked}
                onClick={() => setChoice(option.state)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25",
                  selected
                    ? "bg-muted/55 text-foreground"
                    : "bg-transparent text-foreground/85 hover:bg-muted/30",
                  locked ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                )}
              >
                <span className="min-w-0 flex-1 text-sm font-medium">{option.label}</span>
                {selected ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <Input
            size="compact"
            className="min-w-0 flex-1"
            aria-label="Review comment"
            placeholder="Comment (optional)"
            value={comment}
            disabled={locked}
            onChange={(event) => setComment(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <Button
            size="sm"
            disabled={locked || choice === null || selectedEnvironments.size === 0}
            onClick={() => void submit()}
          >
            {submitting ? "Submitting…" : "Submit review"}
          </Button>
        </div>
      </ComposerBanner.Body>
    </>
  );
}
