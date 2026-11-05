import type { StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FEEDBACK_REPOSITORY,
  type EnvironmentId,
  type FeedbackSubmitResult,
} from "@t3tools/contracts";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { Linking, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";

// Survives leaving the screen, so a report outlasts a trip to fix a sign-in.
const feedbackDraftAtom = Atom.make({ title: "", body: "" }).pipe(
  Atom.keepAlive,
  Atom.withLabel("feedback:draft"),
);

export function SettingsFeedbackRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  const submit = useAtomCommand(serverEnvironment.submitFeedback, { reportFailure: false });
  const [draft, setDraft] = useAtom(feedbackDraftAtom);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FeedbackSubmitResult | null>(null);

  const send = async () => {
    setPending(true);
    setError(null);
    const outcome = await submit({
      environmentId: route.params.environmentId,
      input: { title: draft.title.trim(), body: draft.body.trim() },
    });
    setPending(false);
    if (outcome._tag === "Success") {
      setResult(outcome.value);
      if (outcome.value.status === "filed") setDraft({ title: "", body: "" });
      return;
    }
    const failure = squashAtomCommandFailure(outcome);
    setError(failure instanceof Error ? failure.message : "Could not send the report.");
  };

  const filed = result?.status === "filed" ? result : null;
  const notFiled = result?.status === "not_filed" ? result : null;

  return (
    <SettingsScreen title="Send feedback">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-4 px-5 pt-4 pb-8"
      >
        {filed ? (
          <View className="gap-4">
            <Text className="text-sm text-foreground-muted">Your issue is posted.</Text>
            <Button
              fullWidth
              tone="contrast"
              label="View issue"
              onPress={() => void Linking.openURL(filed.issueUrl)}
            />
          </View>
        ) : (
          <>
            <Text className="text-sm text-foreground-muted">
              {`Report a bug or suggest a change. This posts a public issue on ${FEEDBACK_REPOSITORY} under the GitHub account signed in on this server, with your styal version and operating system added. Leave out anything private.`}
            </Text>
            <TextInput
              accessibilityLabel="Title"
              placeholder="Title"
              placeholderTextColorClassName="accent-foreground-muted"
              maxLength={200}
              editable={!pending}
              value={draft.title}
              onChangeText={(title) => setDraft({ ...draft, title })}
              className="rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
            />
            <TextInput
              multiline
              accessibilityLabel="Description"
              placeholder="What happened, and what did you expect?"
              placeholderTextColorClassName="accent-foreground-muted"
              maxLength={60_000}
              editable={!pending}
              value={draft.body}
              onChangeText={(body) => setDraft({ ...draft, body })}
              className="min-h-32 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
              style={{ textAlignVertical: "top" }}
            />
            {notFiled ? (
              <Text className="text-sm text-danger-foreground">
                {`Your issue wasn't posted, and your text is still here. ${notFiled.reason} You can post again, or post it yourself on GitHub.`}
              </Text>
            ) : null}
            {error === null ? null : (
              <Text className="text-sm text-danger-foreground">{error}</Text>
            )}
            <Button
              fullWidth
              tone="contrast"
              label={pending ? "Posting…" : "Post publicly"}
              loading={pending}
              disabled={draft.title.trim().length === 0 || draft.body.trim().length === 0}
              onPress={() => void send()}
            />
            {notFiled ? (
              <Button
                fullWidth
                label="Open on GitHub"
                onPress={() => void Linking.openURL(notFiled.manualUrl)}
              />
            ) : null}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
