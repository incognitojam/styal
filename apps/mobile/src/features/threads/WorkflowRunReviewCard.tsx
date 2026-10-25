import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId, ThreadWorkflowRunWatch } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "./RequestActionButton";

/** A watched workflow run's deployment review, approved or rejected for every waiting environment. */
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
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState<"approved" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Two taps can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const environments = run.review?.environments;
  if (environments === undefined) return null;

  const submit = async (state: "approved" | "rejected") => {
    if (inFlight.current) return;
    const [first, ...rest] = environments.map((environment) => environment.id);
    if (first === undefined) return;
    inFlight.current = true;
    setPending(state);
    setError(null);
    const result = await review({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        host: run.host,
        repository: run.repository,
        runId: run.runId,
        environmentIds: [first, ...rest],
        state,
        comment: comment.trim(),
      },
    }).finally(() => {
      inFlight.current = false;
      setPending(null);
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

  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        Deployment review
      </Text>
      <Text className="font-t3-bold text-lg text-foreground" numberOfLines={2}>
        {run.name}
      </Text>
      <Text className="font-sans text-sm leading-normal text-foreground-secondary">
        Waiting for your review to deploy to{" "}
        {environments.map((environment) => environment.name).join(", ")}
      </Text>
      <TextInput
        accessibilityLabel="Review comment"
        placeholder="Leave a comment (optional)"
        value={comment}
        onChangeText={setComment}
        editable={pending === null}
        returnKeyType="done"
      />
      {error !== null ? (
        <Text accessibilityRole="alert" className="font-sans text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        <RequestActionButton
          label={pending === "approved" ? "Approving…" : "Approve and deploy"}
          disabled={!canReview || pending !== null}
          onPress={() => void submit("approved")}
        />
        <RequestActionButton
          label={pending === "rejected" ? "Rejecting…" : "Reject"}
          tone="danger"
          disabled={!canReview || pending !== null}
          onPress={() => void submit("rejected")}
        />
      </View>
      <Pressable
        accessibilityRole="link"
        onPress={() => void tryOpenExternalUrl(run.url, "workflow-run")}
      >
        <Text className="font-sans text-xs text-foreground-muted">Open on GitHub</Text>
      </Pressable>
      {!canReview ? (
        <Text className="font-sans text-xs text-foreground-muted">
          This connection cannot review deployments.
        </Text>
      ) : null}
    </View>
  );
}
