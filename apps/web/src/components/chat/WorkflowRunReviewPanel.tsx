import type { EnvironmentId, ThreadId, ThreadWorkflowRunWatch } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon, ChevronUpIcon, ExternalLinkIcon, RocketIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { WorkflowRunLabel } from "./WorkflowRunLabel";

type ReviewState = "approved" | "rejected";

/** One watched run waiting on a deployment review, as a row of the "Needs you" stack. */
export function WorkflowRunReviewRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly run: ThreadWorkflowRunWatch;
  readonly watchActions?: ReactNode;
}) {
  const { run } = props;
  if (run.review === undefined) return null;
  return (
    <WorkflowRunReviewForm
      key={`${run.host}/${run.repository}/${run.runId}`}
      environmentId={props.environmentId}
      threadId={props.threadId}
      run={run}
      environments={run.review.environments}
      watchActions={props.watchActions}
    />
  );
}

function WorkflowRunReviewForm(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly run: ThreadWorkflowRunWatch;
  readonly environments: NonNullable<ThreadWorkflowRunWatch["review"]>["environments"];
  readonly watchActions?: ReactNode;
}) {
  const { run, environments } = props;
  const canReview = useAtomValue(
    pullRequestEnvironment.reviewWorkflowRun.permissionAtom(props.environmentId),
  );
  const review = useAtomCommand(pullRequestEnvironment.reviewWorkflowRun, {
    reportFailure: false,
  });
  // Null until the user edits the form: an untouched form follows every waiting environment,
  // an edited one keeps its picks, so newly waiting environments are never added to it.
  const [picks, setPicks] = useState<ReadonlySet<number> | null>(null);
  const environmentIds = environments.map((environment) => environment.id);
  const selectedEnvironments = new Set(
    environmentIds.filter((id) => picks === null || picks.has(id)),
  );
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const inFlight = useRef(false);

  async function submit(choice: ReviewState) {
    const [first, ...rest] = environments
      .map((environment) => environment.id)
      .filter((id) => selectedEnvironments.has(id));
    if (first === undefined || inFlight.current || !canReview) return;
    inFlight.current = true;
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
    inFlight.current = false;
    setSubmitting(false);
    if (result._tag === "Success") {
      // Reviewed environments leave the picks; ones the user excluded stay excluded.
      const reviewed = new Set([first, ...rest]);
      setPicks((current) =>
        current === null ? null : new Set([...current].filter((id) => !reviewed.has(id))),
      );
      setComment("");
      setExpanded(false);
    }
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
  // Quick Approve sends the form's state, so an edited selection or comment shows in its label.
  const edited = picks !== null;
  const quickApproveLabel = edited
    ? `Approve ${selectedEnvironments.size} ${selectedEnvironments.size === 1 ? "environment" : "environments"}`
    : "Approve";
  return (
    <div>
      <div className="flex items-start gap-2 px-3 py-2">
        <span className="mt-2 size-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm text-foreground">
            Waiting for your review to deploy to{" "}
            {environments.map((environment) => environment.name).join(", ")}.
          </p>
          <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="shrink-0">Deployment review</span>
            <span>·</span>
            <div className="min-w-0 truncate">
              <WorkflowRunLabel name={run.name} />
            </div>
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          {expanded ? null : (
            <Button
              size="xs"
              disabled={locked || selectedEnvironments.size === 0}
              onClick={() => void submit("approved")}
            >
              {quickApproveLabel}
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            Review {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
          </Button>
        </div>
      </div>
      {expanded ? (
        <div className="px-3 pb-3 text-sm">
          {environments.length > 1 || picks !== null ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {environments.map((environment) => (
                <label key={environment.id} className="flex items-center gap-1.5">
                  <Checkbox
                    checked={selectedEnvironments.has(environment.id)}
                    disabled={locked}
                    onCheckedChange={(checked) =>
                      setPicks((current) => {
                        const next = new Set(current ?? environmentIds);
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
          <div className="mt-2">
            <Input
              size="compact"
              aria-label="Review comment"
              placeholder="Leave a comment (optional)"
              value={comment}
              disabled={locked}
              onChange={(event) => {
                setPicks((current) => current ?? new Set(environmentIds));
                setComment(event.currentTarget.value);
              }}
            />
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Open on GitHub"
              render={<a href={run.url} target="_blank" rel="noreferrer" />}
            >
              <ExternalLinkIcon />
            </Button>
            {props.watchActions}
            <span className="flex-1" />
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={locked || selectedEnvironments.size === 0}
              onClick={() => void submit("rejected")}
            >
              Reject
            </Button>
            <Button
              size="sm"
              disabled={locked || selectedEnvironments.size === 0}
              onClick={() => void submit("approved")}
            >
              <RocketIcon />
              Approve and deploy
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
