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
import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProjects, useThreadShells } from "../../state/entities";
import { reportForkClientUsage } from "../../state/forkClientUsage";
import { serverEnvironment } from "../../state/server";
import {
  addPendingComposerAttachments,
  removePendingComposerAttachments,
} from "../../state/composer-pending-attachments";
import {
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  scheduleUnusedComposerAttachmentCleanup,
} from "../../state/use-composer-drafts";
import { useIncomingShare } from "./IncomingShareProvider";
import type { IncomingShareDraft } from "./incoming-share-model";
import {
  importIncomingShareIntoThread,
  shareThreadTargets,
  type ShareThreadTarget,
} from "./incoming-share-thread";

/**
 * Recent threads offered above the project list when content is shared to
 * the app. Choosing one adds the share to that thread's draft and opens it.
 * A share still importing opens the thread at once, with its attachments
 * shown as pending in the composer until they land.
 */
export function ShareToThreadSection(props: {
  readonly shareId: string;
  readonly share: IncomingShareDraft | null;
  readonly searchText: string;
  readonly showNewThreadHeading: boolean;
}) {
  const navigation = useNavigation();
  const { claimShare, consumeShare, importingShare, waitForShare } = useIncomingShare();
  const threads = useThreadShells();
  const projects = useProjects();
  const [isAdding, setIsAdding] = useState(false);
  const targets = shareThreadTargets({ threads, projects, searchText: props.searchText });

  function openThread(target: ShareThreadTarget): void {
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: String(target.thread.environmentId),
        threadId: String(target.thread.id),
      }),
    );
  }

  function select(target: ShareThreadTarget): void {
    if (isAdding) return;
    if (!props.share) {
      void addImportingShareToThread({
        shareId: props.shareId,
        previewUris: importingShare?.id === props.shareId ? importingShare.previewUris : [],
        target,
        claimShare,
        consumeShare,
        waitForShare,
      });
      openThread(target);
      return;
    }
    setIsAdding(true);
    void addShareToThread(props.share, target, consumeShare).then((added) => {
      setIsAdding(false);
      if (added) openThread(target);
    });
  }

  return (
    <>
      {targets.length > 0 ? (
        <ListSection title="Add to a thread">
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
          Start a new thread
        </Text>
      ) : null}
    </>
  );
}

// Outside the component: React Compiler cannot compile try/finally.
async function addImportingShareToThread(input: {
  readonly shareId: string;
  readonly previewUris: ReadonlyArray<string | null>;
  readonly target: ShareThreadTarget;
  readonly claimShare: (shareId: string) => () => void;
  readonly consumeShare: (shareId: string) => Promise<void>;
  readonly waitForShare: (shareId: string) => Promise<IncomingShareDraft | null>;
}): Promise<void> {
  const draftKey = scopedThreadKey(input.target.thread.environmentId, input.target.thread.id);
  const pending = input.previewUris.map((previewUri, index) => ({
    id: `${input.shareId}:pending:${index}`,
    previewUri,
  }));
  const release = input.claimShare(input.shareId);
  addPendingComposerAttachments(draftKey, pending);
  try {
    const share = await input.waitForShare(input.shareId);
    // A failed import was already reported by the share inbox.
    if (share) {
      await addShareToThread(share, input.target, input.consumeShare, () =>
        removePendingComposerAttachments(draftKey, pending),
      );
    }
  } finally {
    removePendingComposerAttachments(draftKey, pending);
    release();
  }
}

async function addShareToThread(
  share: IncomingShareDraft,
  target: ShareThreadTarget,
  consumeShare: (shareId: string) => Promise<void>,
  onMerged?: () => void,
): Promise<boolean> {
  const { environmentId } = target.thread;
  try {
    const { warnings } = await importIncomingShareIntoThread(share, target.thread, {
      serverConfig: appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId)),
      mergeDraft: async (draftKey, content) => {
        const merged = await mergeComposerDraftContent(draftKey, content);
        onMerged?.();
        return merged;
      },
      draftAttachmentIds: (draftKey) =>
        new Set(getComposerDraftSnapshot(draftKey).attachments.map((attachment) => attachment.id)),
      consumeShare,
      releaseUnusedAttachments: scheduleUnusedComposerAttachmentCleanup,
    });
    void reportForkClientUsage(environmentId, {
      feature: "incoming-share-thread",
      action: "added",
      outcome: "success",
    });
    if (warnings.length > 0) {
      Dialog.alert("Some shared content was skipped", warnings.join("\n"));
    }
    return true;
  } catch (error) {
    void reportForkClientUsage(environmentId, {
      feature: "incoming-share-thread",
      action: "added",
      outcome: "failure",
    });
    Dialog.alert(
      "Could not add to thread",
      error instanceof Error ? error.message : "The shared content could not be saved.",
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
  const title = thread.title || "Untitled thread";
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
