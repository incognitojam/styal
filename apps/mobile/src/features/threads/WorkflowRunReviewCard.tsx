import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId, ThreadWorkflowRunWatch } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "./RequestActionButton";

type ReviewState = "approved" | "rejected";

const OPTIONS: ReadonlyArray<{ readonly state: ReviewState; readonly label: string }> = [
  { state: "approved", label: "Approve and deploy" },
  { state: "rejected", label: "Reject" },
];

/**
 * A watched workflow run's deployment review, laid out like a pending question: choose an
 * option, optionally comment, then submit. It reviews every waiting environment.
 */
export function WorkflowRunReviewCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly run: ThreadWorkflowRunWatch;
}) {
  const { run } = props;
  const canReview = useAtomValue(
    composerPullRequests.reviewWorkflowRun.permissionAtom(props.environmentId),
  );
  const review = useAtomCommand(composerPullRequests.reviewWorkflowRun, {
    label: "review workflow run deployments",
    reportFailure: false,
  });
  const [choice, setChoice] = useState<ReviewState | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two taps can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const environments = run.review?.environments;
  if (environments === undefined) return null;

  const submit = async () => {
    const [first, ...rest] = environments.map((environment) => environment.id);
    if (choice === null || first === undefined || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
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
    }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      // A host error carries its readable text in `detail`; its message names the operation.
      setError(
        typeof failure === "object" &&
          failure !== null &&
          "detail" in failure &&
          typeof failure.detail === "string"
          ? failure.detail
          : "Review it on GitHub instead.",
      );
    }
  };

  const locked = !canReview || submitting;
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-2.5">
        <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
          Deployment review
        </Text>
        <Text className="font-t3-bold text-lg text-foreground" numberOfLines={2}>
          {run.name}
        </Text>
      </View>
      <Text className="font-sans text-sm leading-5 text-foreground-secondary">
        Waiting for your review to deploy to{" "}
        {environments.map((environment) => environment.name).join(", ")}.
      </Text>
      <View accessibilityRole="radiogroup" className="gap-2">
        {OPTIONS.map((option) => {
          const selected = choice === option.state;
          return (
            <Pressable
              key={option.state}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected, disabled: locked }}
              disabled={locked}
              className={cn(
                "min-h-12 w-full justify-center rounded-2xl border px-3.5 py-3",
                selected ? "border-primary bg-primary/10" : "border-border bg-input",
              )}
              onPress={() => setChoice(option.state)}
            >
              <Text
                className={cn(
                  "font-t3-bold text-sm",
                  selected ? "text-foreground" : "text-foreground-secondary",
                )}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <TextInput
        accessibilityLabel="Review comment"
        placeholder="Leave a comment (optional)"
        value={comment}
        onChangeText={setComment}
        editable={!locked}
        returnKeyType="done"
        className="min-h-[54px] rounded-2xl border border-input-border bg-input px-3.5 py-3 font-sans text-base text-foreground"
      />
      {error !== null ? (
        <Text accessibilityRole="alert" className="font-sans text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <RequestActionButton
        label={submitting ? "Submitting…" : "Submit review"}
        size="large"
        tone={choice === null ? "secondary" : "primary"}
        disabled={locked || choice === null}
        onPress={() => void submit()}
      />
      <Pressable
        accessibilityRole="link"
        className="items-center justify-center rounded-2xl px-4 py-2.5 active:opacity-70"
        onPress={() => void tryOpenExternalUrl(run.url, "workflow-run")}
      >
        <Text className="font-t3-bold text-sm text-foreground-muted">Open on GitHub</Text>
      </Pressable>
      {!canReview ? (
        <Text className="font-sans text-xs text-foreground-tertiary">
          This connection cannot review deployments.
        </Text>
      ) : null}
    </View>
  );
}
