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
import { ScrollView, useWindowDimensions, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { uuidv4 } from "../../lib/uuid";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { FilePreviewGallery } from "../../components/ui/FilePreviewGallery";
import { PresentationSource } from "../../components/ui/NativePresentation";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { dismissCoordinatorReport } from "../../state/coordinatorReports";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  composerDraftsAtom,
  getComposerDraftSnapshot,
  setComposerDraftText,
  useComposerDraft,
} from "../../state/use-composer-drafts";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { replyTo, ReportAnswerOptions, type ReportState } from "./CoordinatorReports";
import { messageImageGallery } from "./messageImageGallery";
import { AssistantMessageBody, useThreadMarkdown } from "./ThreadFeed";
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
  const { width } = useWindowDimensions();
  const params = route.params;
  const environmentId = EnvironmentId.make(params.environmentId);
  const threadId = ThreadId.make(params.threadId);
  const reportId = MessageId.make(params.report);
  const { selectedThread, selectedThreadDetailRef, selectedEnvironmentRuntime } =
    useThreadSelection();
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
                  contentWidth={Math.max(0, width - BODY_PADDING * 2)}
                />
              </FilePreviewGallery>
            </ScrollView>
            <ReportAnswerBar
              environmentId={environmentId}
              threadId={threadId}
              report={report}
              draftKey={composer.composerDraftKey}
              threadTitle={selectedThread?.title ?? "Thread"}
              onShowLatest={(id) => navigation.dispatch(CommonActions.setParams({ report: id }))}
              send={async (text, reply) => {
                const id = await composer.onSendMessage(undefined, undefined, undefined, {
                  text,
                  reply,
                });
                return id !== null;
              }}
            />
          </>
        )}
        {markdown.previews}
      </KeyboardAvoidingView>
    </PresentationSource>
  );
}

/**
 * The report's question and answers, held under its body: at most part of the screen, its answers
 * scrolling inside it, so the report keeps the rest.
 */
function ReportAnswerBar(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly report: ReportState;
  readonly draftKey: string | null;
  readonly threadTitle: string;
  readonly onShowLatest: (id: string) => void;
  readonly send: (text: string, reply: ReportReply) => Promise<boolean>;
}) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const bottomInset = keyboardVisible ? 0 : insets.bottom;
  const tag = props.report.message.report!;
  const reply = replyTo(props.report);
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const canRespond =
    useAtomValue(dismissCoordinatorReport.permissionAtom(props.environmentId)) && canOperate;
  const dismissReport = useAtomCommand(dismissCoordinatorReport, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);
  const draft = useComposerDraft(props.draftKey);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const voice = useVoiceInputController({
    ownerKey: props.draftKey === null ? null : `report:${props.draftKey}`,
    label: props.threadTitle,
    readDraftMessage: () =>
      props.draftKey === null ? null : getComposerDraftSnapshot(props.draftKey).text,
    subscribeToDraftChanges: (onChange) => appAtomRegistry.subscribe(composerDraftsAtom, onChange),
    selection,
    onChangeDraftMessage: (text) => {
      if (props.draftKey !== null) setComposerDraftText(props.draftKey, text);
    },
    onChangeSelection: setSelection,
  });
  const run = (action: () => Promise<boolean>) => {
    setBusy(true);
    setError(null);
    void action()
      .then((ok) => {
        if (!ok) setError("Could not save your response. Try again.");
      })
      .finally(() => setBusy(false));
  };
  const disabled = !canRespond || busy;
  const replyText = draft.text.trim();

  if (props.report.state === "replaced")
    return (
      <AnswerBarFrame bottom={bottomInset}>
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

  return (
    <AnswerBarFrame bottom={bottomInset} maxHeight={height * 0.45}>
      <Text className="font-t3-medium text-foreground" numberOfLines={replying ? 1 : 2}>
        {tag.question}
      </Text>
      {replying ? (
        <>
          <TextInput
            autoFocus
            multiline
            editable={!voice.freezesEditor}
            value={draft.text}
            onChangeText={(text) => {
              if (props.draftKey !== null) setComposerDraftText(props.draftKey, text);
            }}
            onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
            placeholder="Your reply"
            accessibilityLabel="Your reply"
            className="max-h-36 min-h-12 rounded-lg border border-border px-3 py-3 text-base text-foreground"
          />
          <View className="flex-row items-center justify-between">
            <Button
              label="Cancel"
              size="compact"
              tone="text"
              onPress={() => {
                voice.cancel();
                setReplying(false);
              }}
            />
            <Button
              label="Send reply"
              size="compact"
              tone="primary"
              disabled={disabled || replyText.length === 0 || voice.blocksSubmission}
              onPress={() =>
                run(async () => {
                  const ok = await props.send(replyText, reply);
                  if (ok && props.draftKey !== null) setComposerDraftText(props.draftKey, "");
                  return ok;
                })
              }
            />
          </View>
        </>
      ) : (
        <>
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
                onPress={() => setReplying(true)}
              />
              {voice.isAvailable ? (
                <Button
                  label="Reply by voice"
                  icon="mic"
                  size="compact"
                  tone="text"
                  disabled={disabled}
                  onPress={() => {
                    setReplying(true);
                    voice.start();
                  }}
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
        </>
      )}
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
