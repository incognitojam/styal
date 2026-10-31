import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId, ThreadWorkflowRunWatch } from "@t3tools/contracts";
import { formatWorkflowRunDisplayName } from "@t3tools/client-runtime/state/workflow-run-display";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";

type ReviewState = "approved" | "rejected";

/**
 * A watched workflow run's deployment review. Like GitHub's dialog, it lists environments to
 * pick only when several wait.
 */
export function WorkflowRunReviewCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly run: ThreadWorkflowRunWatch;
  readonly stopWatching?: { readonly disabled: boolean; readonly onPress: () => void } | undefined;
}) {
  const { run } = props;
  const canReview = useAtomValue(
    composerPullRequests.reviewWorkflowRun.permissionAtom(props.environmentId),
  );
  const review = useAtomCommand(composerPullRequests.reviewWorkflowRun, {
    label: "review workflow run deployments",
    reportFailure: false,
  });
  const [selected, setSelected] = useState<ReadonlySet<number>>(
    () => new Set(run.review?.environments.map((environment) => environment.id)),
  );
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two taps can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const environments = run.review?.environments;
  if (environments === undefined) return null;

  const submit = async (choice: ReviewState) => {
    const [first, ...rest] = environments
      .map((environment) => environment.id)
      .filter((id) => selected.has(id));
    if (first === undefined || inFlight.current) return;
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
      <View className="flex-row items-start gap-2.5">
        <View className="flex-1 gap-2.5">
          <Text className="font-t3-bold text-xs text-foreground-secondary">Deployment review</Text>
          <Text
            accessibilityLabel={run.name}
            className="font-t3-bold text-lg text-foreground"
            numberOfLines={2}
          >
            {formatWorkflowRunDisplayName(run.name)}
          </Text>
        </View>
        {props.stopWatching ? (
          <Button label="Stop" tone="secondary" {...props.stopWatching} />
        ) : null}
      </View>
      <Text className="font-sans text-sm leading-5 text-foreground-secondary">
        Waiting for your review to deploy to{" "}
        {environments.map((environment) => environment.name).join(", ")}.
      </Text>
      {environments.length > 1 ? (
        <View className="gap-2">
          {environments.map((environment) => {
            const checked = selected.has(environment.id);
            return (
              <Pressable
                key={environment.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked, disabled: locked }}
                disabled={locked}
                className={cn(
                  "min-h-12 w-full flex-row items-center gap-3 rounded-2xl border px-3.5 py-3",
                  checked ? "border-primary bg-primary/10" : "border-border bg-input",
                )}
                onPress={() =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(environment.id)) next.delete(environment.id);
                    else next.add(environment.id);
                    return next;
                  })
                }
              >
                <View
                  className={cn(
                    "size-5 items-center justify-center rounded-sm",
                    checked ? "bg-primary" : "border border-input-border",
                  )}
                >
                  {checked ? (
                    <SymbolView
                      name="checkmark"
                      size={16}
                      tintColorClassName="accent-primary-foreground"
                      type="monochrome"
                    />
                  ) : null}
                </View>
                <Text className="font-t3-bold text-sm text-foreground">{environment.name}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
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
      <View className="flex-row gap-2.5">
        <View className="flex-1">
          <Button
            label="Reject"
            tone="danger"
            fullWidth
            disabled={locked || selected.size === 0}
            onPress={() => void submit("rejected")}
          />
        </View>
        <View className="flex-1">
          <Button
            label={submitting ? "Submitting…" : "Approve and deploy"}
            tone="primary"
            fullWidth
            disabled={locked || selected.size === 0}
            onPress={() => void submit("approved")}
          />
        </View>
      </View>
      <Pressable
        accessibilityRole="link"
        className="flex-row items-center justify-center gap-1.5 rounded-2xl px-4 py-2.5 active:opacity-70"
        onPress={() => void tryOpenExternalUrl(run.url, "workflow-run")}
      >
        <Text className="font-t3-bold text-sm text-foreground-muted">Open on GitHub</Text>
        <SymbolView
          name="arrow.up.right"
          size={13}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
      </Pressable>
      {!canReview ? (
        <Text className="font-sans text-xs text-foreground-tertiary">
          This connection cannot review deployments.
        </Text>
      ) : null}
    </View>
  );
}
