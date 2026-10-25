import type { EnvironmentId, ThreadId, ThreadWorkflowRunWatch } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { ExternalLinkIcon, RocketIcon, ShieldQuestionIcon } from "lucide-react";
import { useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { ComposerBanner } from "./ComposerBanner";

type ReviewState = "approved" | "rejected";

/**
 * The deployment review a watched workflow run waits on, in the slot above the composer that
 * questions use. Like GitHub's dialog, it lists environments to pick only when several wait.
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
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(choice: ReviewState) {
    const [first, ...rest] = environments
      .map((environment) => environment.id)
      .filter((id) => selectedEnvironments.has(id));
    if (first === undefined || submitting) return;
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
        <Input
          size="compact"
          className="mt-2"
          aria-label="Review comment"
          placeholder="Leave a comment (optional)"
          value={comment}
          disabled={locked}
          onChange={(event) => setComment(event.currentTarget.value)}
        />
        <div className="mt-2 flex justify-end gap-1.5">
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
      </ComposerBanner.Body>
    </>
  );
}
