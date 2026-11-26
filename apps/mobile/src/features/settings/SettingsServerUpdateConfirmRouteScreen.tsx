import { msg, useMessages } from "gt-react-native";
import {
  hostActivityReasonLabels,
  hostActivitySectionHeading,
} from "@t3tools/shared/hostActivityCopy";
import type { ConfirmDialogThreadActivity, EnvironmentId } from "@t3tools/contracts";
import {
  groupHostActivityThreads,
  hostActivityShownReasons,
  hostActivityReasonTone,
  type HostActivityTone,
} from "@t3tools/shared/hostActivity";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useSyncExternalStore } from "react";
import { Platform, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { cn } from "../../lib/cn";
import { SheetActionButton } from "../threads/git/gitSheetComponents";
import {
  confirmServerUpdate,
  readServerUpdateConfirmation,
  releaseServerUpdateConfirmation,
  respondToServerUpdateConfirmation,
  subscribeServerUpdateConfirmations,
} from "./serverUpdateConfirmation";

const badgeClassNames: Record<HostActivityTone, string> = {
  warning: "bg-warning text-warning-foreground",
  info: "bg-primary/15 text-primary-text",
  secondary: "bg-subtle text-foreground-secondary",
};

function ThreadActivityRow({ activity }: { readonly activity: ConfirmDialogThreadActivity }) {
  const m = useMessages();
  const { thread } = activity;
  return (
    <View className="flex-row items-start justify-between gap-3">
      <Text className="min-w-0 flex-1 text-base text-foreground">
        {thread.title.trim() || m(msg("Untitled thread"))}
      </Text>
      <View className="shrink-0 flex-row flex-wrap justify-end gap-1 pt-0.5">
        {hostActivityShownReasons(thread.reasons, activity.continuesAfterRestart).map((reason) => (
          <Text
            key={reason}
            className={cn(
              "overflow-hidden rounded-md px-1.5 py-0.5 text-xs font-t3-medium",
              badgeClassNames[hostActivityReasonTone(reason)],
            )}
          >
            {m(hostActivityReasonLabels[reason])}
          </Text>
        ))}
      </View>
    </View>
  );
}

function ThreadActivityList({
  environmentId,
  activity,
}: {
  readonly environmentId: EnvironmentId;
  readonly activity: ReadonlyArray<ConfirmDialogThreadActivity>;
}) {
  const m = useMessages();
  return groupHostActivityThreads(activity.map((row) => ({ environmentId, ...row }))).map(
    (host) => {
      return (
        <View key={host.key} className="gap-5">
          {host.sections.map((section) => {
            const heading = hostActivitySectionHeading(section.continues, m);
            return (
              <View key={heading} className="gap-3">
                <Text className="text-base font-t3-medium text-foreground">{heading}</Text>
                {section.projects.map((project) => {
                  const projectInfo = project.activity[0]!.thread.project;
                  return (
                    <View key={project.key} className="gap-2">
                      {projectInfo ? (
                        <View className="flex-row items-center gap-2">
                          <ProjectFavicon
                            environmentId={environmentId}
                            projectTitle={projectInfo.title}
                            workspaceRoot={projectInfo.workspaceRoot}
                            faviconPath={projectInfo.faviconPath}
                            projectIcon={projectInfo.projectIcon}
                            size={16}
                          />
                          <Text className="min-w-0 flex-1 text-sm font-t3-medium text-foreground-muted">
                            {projectInfo.title}
                          </Text>
                        </View>
                      ) : null}
                      <View className={cn("gap-2", projectInfo && "pl-6")}>
                        {project.activity.map((item) => (
                          <ThreadActivityRow key={item.thread.threadId} activity={item} />
                        ))}
                      </View>
                    </View>
                  );
                })}
              </View>
            );
          })}
        </View>
      );
    },
  );
}

/** Confirms a server update, listing the threads it would interrupt or continue. */
export function SettingsServerUpdateConfirmRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly requestId: string;
}>) {
  const m = useMessages();
  const { environmentId, requestId } = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  // A running-work check that finishes after the screen opens replaces its content.
  const confirmation = useSyncExternalStore(subscribeServerUpdateConfirmations, () =>
    readServerUpdateConfirmation(requestId),
  );

  // Swiping the sheet away, or any other close, cancels the update.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the pending server update confirmation registry entry when its route unmounts
  useEffect(() => () => releaseServerUpdateConfirmation(requestId), [requestId]);

  const close = (confirmed: boolean) => {
    if (confirmed) {
      if (!confirmServerUpdate(requestId)) return;
    } else {
      respondToServerUpdateConfirmation(requestId, false);
    }
    navigation.goBack();
  };

  return (
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1"
      style={Platform.OS === "android" ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      <View className="min-h-4 pt-2 android:pt-4" />
      <ScreenContent fitToContents>
        <ScrollView
          className="android:shrink android:grow-0 ios:flex-1"
          contentContainerClassName="gap-6 px-5 pb-4 pt-2"
        >
          <View className="gap-2">
            <Text className="text-2xl font-t3-bold text-foreground">
              {confirmation?.title ?? m(msg("Update server?"))}
            </Text>
            <View className="flex-row items-start gap-2">
              {confirmation?.checking ? (
                <AppActivityIndicator size="small" accessibilityLabel={m(msg("Checking"))} />
              ) : null}
              <Text className="min-w-0 flex-1 text-sm leading-normal text-foreground-secondary">
                {confirmation?.message ?? m(msg("This confirmation is no longer available."))}
              </Text>
            </View>
          </View>
          {confirmation?.threadActivity.length ? (
            <ThreadActivityList
              environmentId={environmentId}
              activity={confirmation.threadActivity}
            />
          ) : null}
        </ScrollView>
        <View
          className="flex-row gap-3 px-5 pt-3 android:gap-2"
          style={{ paddingBottom: Math.max(insets.bottom, 18) + 8 }}
        >
          <SheetActionButton icon="xmark" label={m(msg("Cancel"))} onPress={() => close(false)} />
          <SheetActionButton
            icon="arrow.up.circle"
            label={confirmation?.confirmLabel ?? m(msg("Update"))}
            tone="primary"
            disabled={!confirmation}
            onPress={() => close(true)}
          />
        </View>
      </ScreenContent>
    </View>
  );
}
