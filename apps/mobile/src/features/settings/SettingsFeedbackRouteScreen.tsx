import type { StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FEEDBACK_REPOSITORY,
  type EnvironmentId,
  type FeedbackSubmitResult,
} from "@t3tools/contracts";
import { useState } from "react";
import { Linking, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";

export function SettingsFeedbackRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  const submit = useAtomCommand(serverEnvironment.submitFeedback, { reportFailure: false });
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FeedbackSubmitResult | null>(null);

  const send = async () => {
    setPending(true);
    setError(null);
    const outcome = await submit({
      environmentId: route.params.environmentId,
      input: { title: title.trim(), body: body.trim() },
    });
    setPending(false);
    if (outcome._tag === "Success") {
      setResult(outcome.value);
      return;
    }
    const failure = squashAtomCommandFailure(outcome);
    setError(failure instanceof Error ? failure.message : "Could not send the report.");
  };

  return (
    <SettingsScreen title="Send feedback">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-4 px-5 pt-4 pb-8"
      >
        {result === null ? (
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
              value={title}
              onChangeText={setTitle}
              className="rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
            />
            <TextInput
              multiline
              accessibilityLabel="Description"
              placeholder="What happened, and what did you expect?"
              placeholderTextColorClassName="accent-foreground-muted"
              maxLength={60_000}
              editable={!pending}
              value={body}
              onChangeText={setBody}
              className="min-h-32 rounded-[20px] bg-grouped-card p-4 text-base text-foreground"
              style={{ textAlignVertical: "top" }}
            />
            {error === null ? null : (
              <Text className="text-sm text-danger-foreground">{error}</Text>
            )}
            <Button
              fullWidth
              tone="contrast"
              label={pending ? "Posting…" : "Post publicly"}
              loading={pending}
              disabled={title.trim().length === 0 || body.trim().length === 0}
              onPress={() => void send()}
            />
          </>
        ) : (
          <View className="gap-4">
            <Text className="text-sm text-foreground-muted">
              {result.status === "filed"
                ? "Your issue is posted."
                : `Your issue wasn't posted: ${result.reason} You can post it yourself on GitHub.`}
            </Text>
            <Button
              fullWidth
              tone="contrast"
              label={result.status === "filed" ? "View issue" : "Open on GitHub"}
              onPress={() =>
                void Linking.openURL(result.status === "filed" ? result.issueUrl : result.manualUrl)
              }
            />
          </View>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
