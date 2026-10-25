import type { EnvironmentId, ThreadId, ThreadWorkflowRunWatch } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { ExternalLinkIcon, ShieldQuestionIcon } from "lucide-react";
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
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type ReviewedRun = ThreadWorkflowRunWatch & {
  readonly review: NonNullable<ThreadWorkflowRunWatch["review"]>;
};

interface ReviewProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly run: ReviewedRun;
}

/** One banner per watched run that waits for the user's deployment review. */
export function workflowRunReviewBannerItems(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workflowRuns: ReadonlyArray<ThreadWorkflowRunWatch> | undefined;
}): ComposerBannerStackItem[] {
  return (input.workflowRuns ?? []).flatMap((run) => {
    if (run.review === undefined) return [];
    const reviewed = { ...run, review: run.review };
    const key = `${run.host}/${run.repository}/${run.runId}`;
    return [
      {
        id: `workflow-run-review:${key}`,
        variant: "warning",
        priority: "input",
        icon: <ShieldQuestionIcon />,
        title: (
          <>
            <span className="shrink-0 font-medium text-muted-foreground">Deployment review</span>{" "}
            <span className="font-normal">{run.name}</span>
          </>
        ),
        actions: (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Open on GitHub"
            render={<a href={run.url} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon />
          </Button>
        ),
        children: (
          <WorkflowRunReviewForm
            // A new set of waiting environments starts a fresh form.
            key={`${key}:${run.review.environments.map((environment) => environment.id).join(",")}`}
            environmentId={input.environmentId}
            threadId={input.threadId}
            run={reviewed}
          />
        ),
      },
    ];
  });
}

function WorkflowRunReviewForm({ environmentId, threadId, run }: ReviewProps) {
  const canReview = useAtomValue(
    pullRequestEnvironment.reviewWorkflowRun.permissionAtom(environmentId),
  );
  const review = useAtomCommand(pullRequestEnvironment.reviewWorkflowRun, {
    reportFailure: false,
  });
  const { environments } = run.review;
  const [selected, setSelected] = useState<ReadonlySet<number>>(
    () => new Set(environments.map((environment) => environment.id)),
  );
  const [comment, setComment] = useState("");
  const [commenting, setCommenting] = useState(false);
  const [pending, setPending] = useState<"approved" | "rejected" | null>(null);

  async function submit(state: "approved" | "rejected") {
    const [first, ...rest] = environments
      .map((environment) => environment.id)
      .filter((id) => selected.has(id));
    if (first === undefined || pending !== null) return;
    setPending(state);
    const result = await review({
      environmentId,
      input: {
        threadId,
        host: run.host,
        repository: run.repository,
        runId: run.runId,
        environmentIds: [first, ...rest],
        state,
        comment: comment.trim(),
      },
    });
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title:
          state === "approved" ? "Could not approve deployment" : "Could not reject deployment",
        description: readableFailure(
          squashAtomCommandFailure(result),
          "Review it on GitHub instead.",
        ),
      });
    }
  }

  const disabled = !canReview || pending !== null || selected.size === 0;
  const options = [
    { state: "approved", label: pending === "approved" ? "Approving…" : "Approve and deploy" },
    { state: "rejected", label: pending === "rejected" ? "Rejecting…" : "Reject" },
  ] as const;
  return (
    <ComposerBanner.Body className="pe-1 pb-1">
      <p className="text-foreground/85">
        Waiting for your review to deploy to{" "}
        {environments.map((environment) => environment.name).join(", ")}.
      </p>
      {environments.length > 1 ? (
        <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
          {environments.map((environment) => (
            <label key={environment.id} className="flex items-center gap-1.5">
              <Checkbox
                checked={selected.has(environment.id)}
                disabled={pending !== null}
                onCheckedChange={(checked) =>
                  setSelected((current) => {
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
        </span>
      ) : null}
      {/* No digit shortcuts, unlike a question: a stray key must not approve a deployment. */}
      <div className="mt-2 space-y-0.5">
        {options.map((option) => (
          <button
            key={option.state}
            type="button"
            disabled={disabled}
            onClick={() => void submit(option.state)}
            className={cn(
              "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left text-foreground/85 outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25",
              pending === option.state ? "bg-muted/55 text-foreground" : "hover:bg-muted/30",
              disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
            )}
          >
            <span className="text-sm font-medium">{option.label}</span>
          </button>
        ))}
      </div>
      {commenting ? (
        <Input
          size="compact"
          className="mt-1.5"
          aria-label="Review comment"
          placeholder="Comment sent with your review"
          autoFocus
          value={comment}
          disabled={pending !== null}
          onChange={(event) => setComment(event.currentTarget.value)}
        />
      ) : (
        <Button
          size="xs"
          variant="ghost"
          className="mt-1"
          disabled={pending !== null}
          onClick={() => setCommenting(true)}
        >
          Add a comment
        </Button>
      )}
    </ComposerBanner.Body>
  );
}
