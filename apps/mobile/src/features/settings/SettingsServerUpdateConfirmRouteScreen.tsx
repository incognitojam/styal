import type { ConfirmDialogThreadActivity, EnvironmentId } from "@t3tools/contracts";
import {
  groupHostActivityThreads,
  hostActivityReasonLabels,
  hostActivityReasonTone,
  type HostActivityTone,
} from "@t3tools/shared/hostActivity";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { Platform, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { cn } from "../../lib/cn";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SheetActionButton } from "../threads/git/gitSheetComponents";
import {
  readServerUpdateConfirmation,
  respondToServerUpdateConfirmation,
} from "./serverUpdateConfirmation";

const badgeClassNames: Record<HostActivityTone, string> = {
  warning: "bg-warning text-warning-foreground",
  info: "bg-primary/15 text-primary-text",
  secondary: "bg-subtle text-foreground-secondary",
};

function ThreadActivityRow({ activity }: { readonly activity: ConfirmDialogThreadActivity }) {
  const { thread } = activity;
  return (
    <View className="flex-row items-start justify-between gap-3">
      <Text className="min-w-0 flex-1 text-base text-foreground">
        {thread.title.trim() || "Untitled thread"}
      </Text>
      <View className="shrink-0 flex-row flex-wrap justify-end gap-1 pt-0.5">
        {thread.reasons.map((reason) => (
          <Text
            key={reason}
            className={cn(
              "overflow-hidden rounded-md px-1.5 py-0.5 text-xs font-t3-medium",
              badgeClassNames[hostActivityReasonTone(reason)],
            )}
          >
            {hostActivityReasonLabels[reason]}
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
  return groupHostActivityThreads(activity).map((host) => {
    const labelSections = host.sections.some((section) => section.continues);
    return (
      <View key={host.key} className="gap-5">
        {host.sections.map((section) => {
          const heading = section.continues ? "Continues after restart" : "Will be interrupted";
          return (
            <View key={heading} className="gap-3">
              {labelSections ? (
                <Text className="text-base font-t3-medium text-foreground">{heading}</Text>
              ) : null}
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
  });
}

/** Confirms a server update, listing the threads it would interrupt or continue. */
export function SettingsServerUpdateConfirmRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly requestId: string;
}>) {
  const { environmentId, requestId } = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [confirmation] = useState(() => readServerUpdateConfirmation(requestId));

  // Swiping the sheet away, or any other close, cancels the update.
  useEffect(() => () => respondToServerUpdateConfirmation(requestId, false), [requestId]);

  const close = (confirmed: boolean) => {
    respondToServerUpdateConfirmation(requestId, confirmed);
    navigation.goBack();
  };

  return (
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1"
      style={Platform.OS === "android" ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions
          options={{ sheetCornerRadius: 28, sheetAllowedDetents: "fitToContents" }}
        />
      ) : null}
      <View className="min-h-4 pt-2 android:pt-4" />
      <ScreenContent fitToContents>
        <ScrollView
          className="android:shrink android:grow-0 ios:flex-1"
          contentContainerClassName="gap-6 px-5 pb-4 pt-2"
        >
          <View className="gap-2">
            <Text className="text-2xl font-t3-bold text-foreground">
              {confirmation?.title ?? "Update server?"}
            </Text>
            <Text className="text-sm leading-normal text-foreground-secondary">
              {confirmation?.message ?? "This confirmation is no longer available."}
            </Text>
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
          <SheetActionButton icon="xmark" label="Cancel" onPress={() => close(false)} />
          <SheetActionButton
            icon="arrow.up.circle"
            label="Update"
            tone="primary"
            disabled={!confirmation}
            onPress={() => close(true)}
          />
        </View>
      </ScreenContent>
    </View>
  );
}
