import { useAtomValue } from "@effect/atom-react";
import {
  CommonActions,
  StackActions,
  useNavigation,
  useRoute,
  type RouteProp,
  type StaticScreenProps,
} from "@react-navigation/native";
import { resolveProviderSkillsForCwd } from "@t3tools/client-runtime/providerSkills";
import type { ReportReply } from "@t3tools/client-runtime/coordinator-reports";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { renderAssistantCitationsAsText } from "@t3tools/shared/assistantCitations";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { uuidv4 } from "../../lib/uuid";

import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { FilePreviewGallery } from "../../components/ui/FilePreviewGallery";
import { PresentationSource } from "../../components/ui/NativePresentation";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { dismissCoordinatorReport } from "../../state/coordinatorReports";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useGlobalVoiceInput } from "../voice-input/VoiceInputProvider";
import { ComposerPopoverHost } from "./ComposerPopoverHost";
import {
  replyTo,
  ReportAnswerOptions,
  ReportReplyStrip,
  type ReportState,
} from "./CoordinatorReports";
import { messageImageGallery } from "./messageImageGallery";
import { AssistantMessageBody, useThreadMarkdown } from "./ThreadFeed";
import { ThreadComposer } from "./ThreadComposer";
import { requestThreadMessageJump } from "./threadMessageJump";
import { findOpenedReport, reportBodyMarkdown, reportFinished } from "./threadReport.logic";

type ThreadReportParams = {
  readonly environmentId: string;
  readonly threadId: string;
  /** The report message on screen; Show latest moves it to the newest version. */
  readonly report: string;
};

const BODY_PADDING = 20;
const startNoSideChat = async () => false;

/**
 * A report opened from a project's Needs you list: its whole body, with its question and answers
 * in a bar below. Once it is answered or dismissed, the app goes back to the list.
 */
export function ThreadReportRouteScreen(_props: StaticScreenProps<ThreadReportParams>) {
  const route = useRoute<RouteProp<{ ThreadReport: ThreadReportParams }>>();
  const navigation = useNavigation();
  // The body's own width: in a split view the report pane is narrower than the window.
  const [bodyWidth, setBodyWidth] = useState(0);
  const params = route.params;
  const environmentId = EnvironmentId.make(params.environmentId);
  const threadId = ThreadId.make(params.threadId);
  const reportId = MessageId.make(params.report);
  const {
    selectedThread,
    selectedThreadDetailRef,
    selectedEnvironmentRuntime,
    selectedEnvironmentConnection,
  } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const composer = useThreadComposerState({ startSideChat: startNoSideChat });
  const threadState = useEnvironmentThread(
    selectedThreadDetailRef?.environmentId ?? null,
    selectedThreadDetailRef?.threadId ?? null,
  );
  const opened = findOpenedReport(composer.reports, reportId, {
    ready: threadState.status === "live",
    history: threadState.history,
  });
  const report = opened.kind === "found" ? opened.report : null;
  const loadEarlierHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    reportFailure: false,
  });
  const requestedHistory = useRef(false);
  const needsHistory =
    opened.kind === "loading" &&
    threadState.status === "live" &&
    !threadState.history.loading &&
    selectedThreadDetailRef !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server once for the history down to a report older than the loaded page
  useEffect(() => {
    if (!needsHistory || requestedHistory.current || selectedThreadDetailRef === null) return;
    requestedHistory.current = true;
    void loadEarlierHistory({
      environmentId: selectedThreadDetailRef.environmentId,
      input: { threadId: selectedThreadDetailRef.threadId, throughEntryId: reportId },
    });
  }, [needsHistory, selectedThreadDetailRef, reportId, loadEarlierHistory]);

  const finished = report !== null && reportFinished(report);
  const returned = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- goes back once the answer or dismissal is on record; navigation is outside React
  useEffect(() => {
    if (!finished || returned.current) return;
    returned.current = true;
    navigation.goBack();
  }, [finished, navigation]);

  const threadKey =
    selectedThreadDetailRef === null
      ? null
      : scopedThreadKey(selectedThreadDetailRef.environmentId, selectedThreadDetailRef.threadId);
  const openThread = () => {
    if (selectedThreadDetailRef === null || threadKey === null) return;
    requestThreadMessageJump(threadKey, reportId);
    const state = navigation.getState();
    const below = state?.routes[state.index - 1];
    const belowParams = below?.params as { threadId?: string } | undefined;
    if (below?.name === "Thread" && belowParams?.threadId === params.threadId) {
      navigation.goBack();
      return;
    }
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: params.environmentId,
        threadId: params.threadId,
      }),
    );
  };

  const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
    (candidate) => candidate.instanceId === selectedThread?.modelSelection.instanceId,
  );
  const skills = provider ? resolveProviderSkillsForCwd(provider, selectedThreadCwd) : [];
  const markdown = useThreadMarkdown({
    environmentId,
    threadId,
    workspaceRoot: selectedThreadCwd,
    skills,
    presentationKind: "report",
  });
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const insets = useSafeAreaInsets();
  const popoverHeight = useSharedValue(0);
  const dictationRef = useRef<{ readonly start: () => boolean }>(null);
  const startDictation = useRef(false);
  const voiceAvailable = useGlobalVoiceInput().isAvailable;
  const replying = report !== null && composer.reportReply?.ref.messageId === report.message.id;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts dictation in the composer that Reply by voice just mounted; its handle exists only after mount
  useEffect(() => {
    if (!replying || !startDictation.current) return;
    startDictation.current = false;
    dictationRef.current?.start();
  }, [replying]);
  // The bar folds to its question while the report scrolls, so the report gets the screen.
  const [barFolded, setBarFolded] = useState(false);
  const unfoldAtEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    if (layoutMeasurement.height + contentOffset.y >= contentSize.height - 24) setBarFolded(false);
  };
  const tag = report?.message.report;
  const versions = tag
    ? composer.reports.filter((entry) => entry.message.report?.key === tag.key)
    : [];
  const subtitle = [
    versions.length > 1 && tag ? `Version ${tag.version}` : null,
    selectedThread?.title ?? null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <PresentationSource identifier={markdown.fileShareSourceIdentifier} style={{ flex: 1 }}>
      <KeyboardAvoidingView automaticOffset behavior="height" className="flex-1 bg-screen">
        <AppBar
          title={tag?.title ?? "Report"}
          subtitle={subtitle || undefined}
          onBack={() => navigation.goBack()}
          actions={[
            {
              accessibilityLabel: "Open thread",
              icon: "text.bubble",
              onPress: openThread,
            },
          ]}
        />
        {report === null || selectedThreadDetailRef === null ? (
          <View className="flex-1 items-center justify-center p-6">
            <Text className="text-center text-foreground-secondary">
              {opened.kind === "gone" ? "This report is no longer available." : "Loading report…"}
            </Text>
          </View>
        ) : (
          <>
            <ScrollView
              className="flex-1"
              onLayout={(event) => setBodyWidth(event.nativeEvent.layout.width)}
              onScrollBeginDrag={() => setBarFolded(true)}
              onScrollEndDrag={unfoldAtEnd}
              onMomentumScrollEnd={unfoldAtEnd}
              contentInsetAdjustmentBehavior="automatic"
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ padding: BODY_PADDING, paddingBottom: 32 }}
            >
              <FilePreviewGallery
                value={messageImageGallery(report.message, {
                  environmentId: selectedThreadDetailRef.environmentId,
                  threadId: selectedThreadDetailRef.threadId,
                  workspaceRoot: selectedThreadCwd,
                })}
              >
                <AssistantMessageBody
                  environmentId={selectedThreadDetailRef.environmentId}
                  text={reportBodyMarkdown(
                    renderAssistantCitationsAsText(report.message.text),
                    tag?.title ?? "",
                  )}
                  attachments={report.message.attachments ?? []}
                  markdownStyles={markdown.markdownStyles.assistant}
                  linkHandlers={markdown.markdownLinkHandlers}
                  renderImage={markdown.renderMarkdownImage}
                  onPressPreview={markdown.onPressPreview}
                  onPlaybackStart={markdown.onInlinePlaybackStart}
                  skills={skills}
                  contentWidth={Math.max(0, bodyWidth - BODY_PADDING * 2)}
                />
              </FilePreviewGallery>
            </ScrollView>
            {replying && selectedThread !== null && tag ? (
              <ComposerPopoverHost hidden={false} inFlow popoverHeight={popoverHeight}>
                <ThreadComposer
                  header={
                    <ReportReplyStrip
                      title={tag.title}
                      version={tag.version}
                      question={tag.question}
                      onCancel={() => composer.onReportReply(null)}
                    />
                  }
                  canOperateThread={canOperate}
                  placeholder="Your reply"
                  connectionState={selectedEnvironmentRuntime?.connectionState ?? "available"}
                  environmentLabel={selectedEnvironmentConnection?.environmentLabel ?? null}
                  selectedThread={selectedThread}
                  hasCompactableConversation={false}
                  serverConfig={selectedEnvironmentRuntime?.serverConfig ?? null}
                  queueCount={composer.selectedThreadQueueCount}
                  activeThreadBusy={composer.activeThreadBusy}
                  canStopThread={false}
                  environmentId={environmentId}
                  projectCwd={selectedThreadCwd}
                  draftKey={composer.composerDraftKey ?? undefined}
                  followUpBehavior={composer.followUpBehavior}
                  canSteerActiveTurn={composer.canSteerActiveTurn}
                  hidden={false}
                  dictationRef={dictationRef}
                  bottomInset={keyboardVisible ? 8 : insets.bottom}
                  onChangeDraftMessage={composer.onChangeDraftMessage}
                  onPickDraftMedia={composer.onPickDraftMedia}
                  onPickDraftFiles={composer.onPickDraftFiles}
                  onNativePasteImages={composer.onNativePasteImages}
                  onNativePasteText={composer.onNativePasteText}
                  onRemoveDraftImage={composer.onRemoveDraftImage}
                  onStopThread={() => undefined}
                  onResumeQueue={null}
                  onSendMessage={(followUp) => composer.onSendMessage(followUp)}
                  onShowUsageLimits={() => undefined}
                  canSwitchProvider={composer.canSwitchThreadProvider}
                />
              </ComposerPopoverHost>
            ) : (
              <ReportAnswerBar
                environmentId={environmentId}
                threadId={threadId}
                report={report}
                folded={barFolded}
                onUnfold={() => setBarFolded(false)}
                onShowLatest={(id) => navigation.dispatch(CommonActions.setParams({ report: id }))}
                onReply={() => composer.onReportReply(replyTo(report))}
                onReplyByVoice={
                  voiceAvailable
                    ? () => {
                        startDictation.current = true;
                        composer.onReportReply(replyTo(report));
                      }
                    : undefined
                }
                send={async (text, reply) => {
                  const id = await composer.onSendMessage(undefined, undefined, undefined, {
                    text,
                    reply,
                  });
                  return id !== null;
                }}
              />
            )}
          </>
        )}
        {markdown.previews}
      </KeyboardAvoidingView>
    </PresentationSource>
  );
}

/**
 * The report's question and answers, held under its body: at most part of the screen, its answers
 * scrolling inside it, and folded to the question while the report scrolls.
 */
function ReportAnswerBar(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly report: ReportState;
  readonly folded: boolean;
  readonly onUnfold: () => void;
  readonly onShowLatest: (id: string) => void;
  readonly onReply: () => void;
  /** Absent where dictation can't start. */
  readonly onReplyByVoice: (() => void) | undefined;
  readonly send: (text: string, reply: ReportReply) => Promise<boolean>;
}) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const tag = props.report.message.report!;
  const reply = replyTo(props.report);
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const canRespond =
    useAtomValue(dismissCoordinatorReport.permissionAtom(props.environmentId)) && canOperate;
  const dismissReport = useAtomCommand(dismissCoordinatorReport, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A sent response keeps the bar disabled until the thread records it and the screen closes.
  const run = (action: () => Promise<boolean>) => {
    setBusy(true);
    setError(null);
    void action().then(
      (ok) => {
        if (ok) return;
        setError("Could not save your response. Try again.");
        setBusy(false);
      },
      () => {
        setError("Could not save your response. Try again.");
        setBusy(false);
      },
    );
  };
  const disabled = !canRespond || busy;

  if (props.report.state === "replaced")
    return (
      <AnswerBarFrame bottom={insets.bottom}>
        <View className="flex-row items-center gap-2">
          <Text className="flex-1 text-foreground">A newer version of this report arrived.</Text>
          <Button
            label="Show latest"
            size="compact"
            tone="text"
            onPress={() => props.onShowLatest(props.report.latest.id)}
          />
        </View>
      </AnswerBarFrame>
    );
  if (props.report.state !== "open") return null;
  if (props.folded)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${tag.question ?? "Answers"}, show answers`}
        onPress={props.onUnfold}
        className="active:opacity-70"
      >
        <AnswerBarFrame bottom={insets.bottom}>
          <View className="flex-row items-center gap-2">
            <Text className="flex-1 font-t3-medium text-foreground" numberOfLines={1}>
              {tag.question}
            </Text>
            <SymbolView name="chevron.up" size={13} tintColorClassName="accent-foreground-muted" />
          </View>
        </AnswerBarFrame>
      </Pressable>
    );

  return (
    <AnswerBarFrame bottom={insets.bottom} maxHeight={height * 0.45}>
      <Text className="font-t3-medium text-foreground" numberOfLines={2}>
        {tag.question}
      </Text>
      <ScrollView
        className="shrink"
        contentContainerClassName="gap-2"
        keyboardShouldPersistTaps="handled"
      >
        <ReportAnswerOptions
          answers={tag.answers ?? []}
          disabled={disabled}
          onPick={(answer) => run(() => props.send(answer, reply))}
        />
      </ScrollView>
      <View className="flex-row items-center justify-between">
        <View className="flex-row">
          <Button
            label="Reply…"
            size="compact"
            tone="text"
            disabled={disabled}
            onPress={props.onReply}
          />
          {props.onReplyByVoice ? (
            <Button
              label="Reply by voice"
              icon="mic"
              size="compact"
              tone="text"
              disabled={disabled}
              onPress={props.onReplyByVoice}
            />
          ) : null}
        </View>
        <Button
          label="Dismiss"
          size="compact"
          tone="text"
          disabled={disabled}
          onPress={() =>
            run(async () => {
              const result = await dismissReport({
                environmentId: props.environmentId,
                input: {
                  commandId: CommandId.make(uuidv4()),
                  threadId: props.threadId,
                  ...reply.ref,
                },
              });
              return !AsyncResult.isFailure(result);
            })
          }
        />
      </View>
      {error ? (
        <Text accessibilityRole="alert" className="text-danger">
          {error}
        </Text>
      ) : null}
    </AnswerBarFrame>
  );
}

function AnswerBarFrame(props: {
  readonly bottom: number;
  readonly maxHeight?: number;
  readonly children: ReactNode;
}) {
  return (
    <View
      className="gap-2 border-t border-border bg-secondary px-4 pt-3"
      style={{ paddingBottom: props.bottom + 8, maxHeight: props.maxHeight }}
    >
      {props.children}
    </View>
  );
}
