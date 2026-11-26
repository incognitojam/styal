import { msg, T, useGT } from "gt-react-native";
import { m } from "../../i18n/messages";
import * as Dialog from "../../components/ui/Dialog";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ListSection } from "../../components/ui/ListSection";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { cn } from "../../lib/cn";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import {
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  scheduleUnusedComposerAttachmentCleanup,
} from "../../state/use-composer-drafts";
import { consumeShare } from "./IncomingShareProvider";
import type { IncomingShareDraft } from "./incoming-share-model";
import { importIncomingShareIntoThread, type ShareThreadTarget } from "./incoming-share-thread";

export function useShareToThreadSubtitle(share: IncomingShareDraft | null) {
  const gt = useGT();
  return share
    ? share.attachments.length === 0
      ? gt("Where should this go?")
      : share.attachments.length === 1
        ? share.attachments[0]?.type === "image"
          ? gt("Where should this image go?")
          : gt("Where should this file go?")
        : share.attachments.every((attachment) => attachment.type === "image")
          ? gt("{count, plural, other {Where should these {count} images go?}}", {
              count: share.attachments.length,
            })
          : gt("{count, plural, other {Where should these {count} files go?}}", {
              count: share.attachments.length,
            })
    : null;
}

/**
 * Recent threads offered above the project list when content is shared to
 * the app. Choosing one adds the share to that thread's draft and opens it.
 */
export function ShareToThreadSection(props: {
  readonly share: IncomingShareDraft;
  readonly targets: ReadonlyArray<ShareThreadTarget>;
  readonly showNewThreadHeading: boolean;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const [isAdding, setIsAdding] = useState(false);
  const { targets } = props;

  function select(target: ShareThreadTarget): void {
    if (isAdding) return;
    setIsAdding(true);
    void addShareToThread(props.share, target, consumeShare).then((added) => {
      setIsAdding(false);
      if (!added) return;
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: String(target.thread.environmentId),
          threadId: String(target.thread.id),
        }),
      );
    });
  }

  return (
    <>
      {targets.length > 0 ? (
        <ListSection title={gt("Add to a thread")}>
          {targets.map((target, index) => (
            <ShareThreadRow
              key={`${target.thread.environmentId}:${target.thread.id}`}
              target={target}
              first={index === 0}
              disabled={isAdding}
              onPress={() => select(target)}
            />
          ))}
        </ListSection>
      ) : null}
      {props.showNewThreadHeading ? (
        <Text
          textRole="footnote"
          className={cn(
            "font-t3-medium text-foreground-muted",
            Platform.OS === "android" ? "px-4" : "px-2",
          )}
        >
          <T>Start a new thread</T>
        </Text>
      ) : null}
    </>
  );
}

// Outside the component: React Compiler cannot compile try/finally.
async function addShareToThread(
  share: IncomingShareDraft,
  target: ShareThreadTarget,
  consumeShare: (shareId: string) => Promise<void>,
): Promise<boolean> {
  const { environmentId } = target.thread;
  try {
    const { warnings } = await importIncomingShareIntoThread(share, target.thread, {
      serverConfig: appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId)),
      mergeDraft: mergeComposerDraftContent,
      draftAttachmentIds: (draftKey) =>
        new Set(getComposerDraftSnapshot(draftKey).attachments.map((attachment) => attachment.id)),
      consumeShare,
      releaseUnusedAttachments: scheduleUnusedComposerAttachmentCleanup,
    });

    if (warnings.length > 0) {
      Dialog.alert(m(msg("Some shared content was skipped")), warnings.join("\n"));
    }
    return true;
  } catch (error) {
    Dialog.alert(
      m(msg("Could not add to thread")),
      error instanceof Error ? error.message : m(msg("The shared content could not be saved.")),
    );
    return false;
  }
}

function ShareThreadRow(props: {
  readonly target: ShareThreadTarget;
  readonly first: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const { thread, project } = props.target;
  const gt = useGT();
  const title = thread.title || gt("Untitled thread");
  const favicon = (size: number) => (
    <ProjectFavicon
      environmentId={project.environmentId}
      faviconPath={project.faviconPath}
      projectIcon={project.projectIcon}
      size={size}
      projectTitle={project.title}
      workspaceRoot={project.workspaceRoot}
    />
  );
  if (Platform.OS === "android") {
    return (
      <NavigationRow
        className="bg-grouped-card"
        title={title}
        subtitle={project.title}
        subtitleNumberOfLines={1}
        disabled={props.disabled}
        onPress={props.onPress}
        leading={favicon(24)}
      />
    );
  }
  return (
    <View className={cn(!props.first && "border-t border-border-subtle")}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${project.title}`}
        disabled={props.disabled}
        onPress={props.onPress}
        className={cn(
          "flex-row items-center gap-3 bg-grouped-card px-4 py-3.5",
          props.disabled && "opacity-45",
        )}
      >
        <View className="h-7 w-7 items-center justify-center">{favicon(20)}</View>
        <View className="min-w-0 flex-1">
          <Text className="text-base font-t3-bold leading-snug" numberOfLines={1}>
            {title}
          </Text>
          <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={1}>
            {project.title}
          </Text>
        </View>
        <SymbolView
          name="chevron.right"
          size={14}
          tintColorClassName="accent-chevron"
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}
