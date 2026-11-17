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

export function WorkflowRunReviewPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runs: ReadonlyArray<ThreadWorkflowRunWatch>;
  readonly watchActions?: ReactNode;
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
      watchActions={props.watchActions}
    />
  );
}

function WorkflowRunReviewForm(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly run: ThreadWorkflowRunWatch;
  readonly environments: NonNullable<ThreadWorkflowRunWatch["review"]>["environments"];
  readonly waitingCount: number;
  readonly watchActions?: ReactNode;
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
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const inFlight = useRef(false);

  async function submit(choice: ReviewState, quick = false) {
    const [first, ...rest] = environments
      .map((environment) => environment.id)
      .filter((id) => quick || selectedEnvironments.has(id));
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
        comment: quick ? "" : comment.trim(),
      },
    });
    inFlight.current = false;
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
            {props.waitingCount > 1 ? (
              <span className="shrink-0">· 1/{props.waitingCount}</span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="xs" disabled={locked} onClick={() => void submit("approved", true)}>
            Approve
          </Button>
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
          {environments.length > 1 ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1">
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
          <div className="mt-2">
            <Input
              size="compact"
              aria-label="Review comment"
              placeholder="Leave a comment (optional)"
              value={comment}
              disabled={locked}
              onChange={(event) => setComment(event.currentTarget.value)}
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
