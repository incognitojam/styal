import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { NonNegativeInt } from "./baseSchemas.ts";
import { PreviewAppearancePreference, PreviewZoomFactor } from "./preview.ts";
import { PullRequestMergeMethod } from "./pullRequest.ts";
import {
  AppearanceContrast,
  BrowserLinkTarget,
  BrowserSearchEngine,
  BrowserRecordingFrameRate,
  ChatWidth,
  CodeFontSize,
  DiffColorScheme,
  DiffLayout,
  EnvironmentIdentificationMode,
  GlassOpacity,
  InterfaceFontSize,
  NotificationMode,
  NotificationSound,
  PanelAnimationDurationMs,
  PromptFontSize,
  QuitConfirmationMode,
  SidebarProjectGroupingMode,
  SidebarProjectSortOrder,
  SidebarThreadGrouping,
  SidebarThreadPreviewCount,
  SidebarThreadSortOrder,
  SidebarThreadTimestampMode,
  SnapShotSound,
  TerminalFontSize,
  TimestampFormat,
} from "./settings.ts";

/** Bump when extending the vocabulary; clients require the complete version before reporting. */
export const FORK_CLIENT_USAGE_VERSION = 19;

/**
 * One device's client preferences, reported daily so we can see which defaults
 * people change. Free text, profile and project identifiers stay on the device;
 * they appear only as `...Customized` or a count.
 */
export const ClientSettingsSnapshot = Schema.Struct({
  feature: Schema.Literal("client-settings"),
  action: Schema.Literal("snapshot"),
  // Composer and conversation
  sendShortcut: Schema.Literals(["enter", "mod-enter-multiline", "mod-enter"]),
  followUpBehavior: Schema.Literals(["queue", "steer"]),
  composerRichTextEnabled: Schema.Boolean,
  composerCollapseOnScroll: Schema.Boolean,
  persistComposerContextStrip: Schema.Boolean,
  proactivePanelsEnabled: Schema.Boolean,
  showSkillsInSlashMenu: Schema.Boolean,
  planModeEnabled: Schema.Boolean,
  contextWindowMeterEnabled: Schema.Boolean,
  turnUsageEnabled: Schema.Boolean,
  turnUsageFigure: Schema.Literals(["tokens", "cost"]),
  chatWidth: ChatWidth,
  wordWrap: Schema.Boolean,
  mathRenderingEnabled: Schema.Boolean,
  timestampFormat: TimestampFormat,
  loadBalancingEnabled: Schema.Boolean,
  legacySidebarEnabled: Schema.Boolean,
  sidebarWorkingShelfEnabled: Schema.Boolean,
  sidebarThreadGrouping: SidebarThreadGrouping,
  sidebarProjectGroupingMode: SidebarProjectGroupingMode,
  sidebarProjectGroupingOverrideCount: NonNegativeInt,
  sidebarProjectSortOrder: SidebarProjectSortOrder,
  /** Whether this device has dragged projects into a saved order. */
  sidebarManualProjectOrderSaved: Schema.Boolean,
  sidebarThreadSortOrder: SidebarThreadSortOrder,
  sidebarThreadTimestampMode: SidebarThreadTimestampMode,
  sidebarThreadPreviewCount: SidebarThreadPreviewCount,
  confirmThreadArchive: Schema.Boolean,
  confirmThreadDelete: Schema.Boolean,
  confirmThreadUnpin: Schema.Boolean,
  notificationMode: NotificationMode,
  inAppNotificationsEnabled: Schema.Boolean,
  completionSound: NotificationSound,
  inputSound: NotificationSound,
  approvalSound: NotificationSound,
  claudeStatusAlertsEnabled: Schema.Boolean,
  openaiStatusAlertsEnabled: Schema.Boolean,
  githubStatusAlertsEnabled: Schema.Boolean,
  appearanceContrast: AppearanceContrast,
  glassOpacity: GlassOpacity,
  panelAnimationDurationMs: PanelAnimationDurationMs,
  environmentIdentificationMode: EnvironmentIdentificationMode,
  fontSizeInterface: InterfaceFontSize,
  fontSizePrompt: PromptFontSize,
  fontSizeCode: CodeFontSize,
  fontSizeTerminal: TerminalFontSize,
  fontFamilySansCustomized: Schema.Boolean,
  fontFamilyComposerCustomized: Schema.Boolean,
  fontFamilyCodeCustomized: Schema.Boolean,
  fontFamilyTerminalCustomized: Schema.Boolean,
  fontSmoothing: Schema.Boolean,
  diffColorScheme: DiffColorScheme,
  diffLayout: DiffLayout,
  diffFilesCollapsed: Schema.Boolean,
  diffIgnoreWhitespace: Schema.Boolean,
  browserLinkTarget: BrowserLinkTarget,
  pullRequestLinksOpenInApp: Schema.Boolean,
  browserAutoShowFloatingPreview: Schema.Boolean,
  browserDefaultViewport: Schema.Literals(["fill", "freeform", "preset"]),
  browserDefaultZoomFactor: PreviewZoomFactor,
  browserDefaultAppearance: PreviewAppearancePreference,
  browserSearchEngine: BrowserSearchEngine,
  browserCustomSearchUrlCustomized: Schema.Boolean,
  browserProfileCount: NonNegativeInt,
  browserDefaultProfileCustomized: Schema.Boolean,
  browserRecordingFrameRate: BrowserRecordingFrameRate,
  browserRecordingShowKeyPresses: Schema.Boolean,
  browserRecordingShowMousePresses: Schema.Boolean,
  // Desktop app
  confirmQuit: QuitConfirmationMode,
  discordRichPresence: Schema.Boolean,
  snapShotEnabled: Schema.Boolean,
  snapShotShortcutCustomized: Schema.Boolean,
  snapShotIncludeAccessibility: Schema.Boolean,
  snapShotPlaySound: Schema.Boolean,
  snapShotSound: SnapShotSound,
  snapShotFlash: Schema.Boolean,
  snapShotAnimations: Schema.Boolean,
});
export type ClientSettingsSnapshot = typeof ClientSettingsSnapshot.Type;

/**
 * What a server accepts as a snapshot. Every setting is optional because the
 * version gate only stops newer clients: a client that predates a setting
 * still reports, and the setting is recorded as absent rather than as a choice.
 * Clients build the strict `ClientSettingsSnapshot`.
 */
export const ReportedClientSettingsSnapshot = ClientSettingsSnapshot.mapFields(
  Struct.mapOmit(["feature", "action"], Schema.optionalKey),
);

const MobileThemeId = Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,64}$/));

/**
 * One phone's app preferences, reported daily like `ClientSettingsSnapshot`.
 * Settings that mirror a web one keep its name; free text, accounts, project
 * keys and filters stay on the device.
 */
export const MobileSettingsSnapshot = Schema.Struct({
  feature: Schema.Literal("mobile-settings"),
  action: Schema.Literal("snapshot"),
  // Notifications
  /** The OS lets the app show agent alerts; the switches below choose which. */
  notificationsEnabled: Schema.Boolean,
  liveActivitiesEnabled: Schema.Boolean,
  notifyOnApproval: Schema.Boolean,
  notifyOnInput: Schema.Boolean,
  notifyOnCompletion: Schema.Boolean,
  notifyOnFailure: Schema.Boolean,
  attendedAlertDelaySeconds: NonNegativeInt,
  // Composer and threads
  composerEnterBehavior: Schema.Literals(["send", "newline"]),
  followUpBehavior: Schema.Literals(["queue", "steer"]),
  planModeEnabled: Schema.Boolean,
  turnUsageEnabled: Schema.Boolean,
  turnUsageFigure: Schema.Literals(["tokens", "cost"]),
  confirmThreadUnpin: Schema.Boolean,
  threadTimestampMode: SidebarThreadTimestampMode,
  threadGrouping: SidebarThreadGrouping,
  projectGroupingMode: SidebarProjectGroupingMode,
  workingShelfEnabled: Schema.Boolean,
  threadListWorkingShelfExpanded: Schema.Boolean,
  threadListSettledShelfExpanded: Schema.Boolean,
  threadListSnoozedShelfExpanded: Schema.Boolean,
  modelFavoriteCount: NonNegativeInt,
  microphoneOrderCustomized: Schema.Boolean,
  // Appearance
  themeMode: Schema.Literals(["system", "light", "dark"]),
  lightThemeId: MobileThemeId,
  darkThemeId: MobileThemeId,
  baseFontSize: Schema.Number,
  /** Null follows the base font size. */
  terminalFontSize: Schema.NullOr(Schema.Number),
  codeFontSize: Schema.NullOr(Schema.Number),
  codeWordBreak: Schema.Boolean,
  mathRenderingEnabled: Schema.Boolean,
  // Review and pull requests
  diffSortMode: Schema.Literals(["relevance", "alphabetical"]),
  pullRequestHideTestFiles: Schema.Boolean,
  pullRequestMergeMethod: PullRequestMergeMethod,
});
export type MobileSettingsSnapshot = typeof MobileSettingsSnapshot.Type;

/** What a server accepts from mobile; see `ReportedClientSettingsSnapshot`. */
export const ReportedMobileSettingsSnapshot = MobileSettingsSnapshot.mapFields(
  Struct.mapOmit(["feature", "action"], Schema.optionalKey),
);

export const WebBuildUpdateUsageAction = Schema.Literals(["notice_shown", "refresh_requested"]);
export type WebBuildUpdateUsageAction = typeof WebBuildUpdateUsageAction.Type;

/** Closed UI observations only: content, paths and identifiers stay in the client. */
export const ForkClientUsageInput = Schema.Union([
  Schema.Struct({
    feature: Schema.Literal("integration-settings"),
    action: Schema.Literal("change_requested"),
    setting: Schema.Literals([
      "browser_access",
      "device_support",
      "device_access",
      "device_idle_shutdown",
      "device_sharing",
    ]),
    settingScope: Schema.Literals(["environment", "project"]),
  }),
  Schema.Struct({
    feature: Schema.Literal("pull-request-deployments"),
    action: Schema.Literals(["open_environment", "open_logs", "show_all"]),
    outcome: Schema.Literals(["success", "failure"]),
  }),
  Schema.Struct({
    feature: Schema.Literal("web-build-update-notice"),
    action: WebBuildUpdateUsageAction,
  }),
  Schema.Struct({
    feature: Schema.Literal("combined-update-confirmation"),
    action: Schema.Literals(["shown", "confirmed", "cancelled"]),
  }),
  Schema.Struct({
    feature: Schema.Literal("diff-file-review-order"),
    action: Schema.Literals(["relevance_selected", "alphabetical_selected"]),
    view: Schema.Literals(["changes", "pull_request"]),
  }),
  Schema.Struct({
    feature: Schema.Literal("device-stream-health"),
    action: Schema.Literal("session_ended"),
    platform: Schema.Literals(["android", "ios"]),
    transport: Schema.Literals(["h264", "avcc", "mjpeg"]),
    connection: Schema.Literals(["loopback", "network"]),
    durationSeconds: NonNegativeInt,
    averageFps: NonNegativeInt,
    decoderResets: NonNegativeInt,
    reconnects: NonNegativeInt,
    stalls: Schema.NullOr(NonNegativeInt),
    longestGapMs: Schema.NullOr(NonNegativeInt),
    maxAddedDelayMs: Schema.NullOr(NonNegativeInt),
  }),
  Schema.Struct({
    feature: Schema.Literal("mentioned-time-chips"),
    action: Schema.Literal("details_opened"),
  }),
  Schema.Struct({
    feature: Schema.Literal("setup-thread-settlement"),
    action: Schema.Literal("continued"),
    settleOnMerge: Schema.Boolean,
    settleWhenInactive: Schema.Boolean,
  }),
  Schema.Struct({
    feature: Schema.Literal("sidebar-project-filter"),
    action: Schema.Literals(["filter_set", "filter_cleared"]),
    entryPoint: Schema.Literals(["filter_menu", "project_menu", "thread_menu"]),
  }),
  Schema.Struct({
    feature: Schema.Literal("sidebar-project-filter"),
    action: Schema.Literal("thread_started"),
  }),
  Schema.Struct({
    feature: Schema.Literal("sidebar-project-groups"),
    /** `reordered` moves an unpinned project; the others change its pin or archive state. */
    action: Schema.Literals(["reordered", "pinned", "unpinned", "pins_reordered", "archived"]),
    entryPoint: Schema.Literals(["header_drag", "header_menu"]),
  }),
  Schema.Struct({
    feature: Schema.Literal("next-unread-thread"),
    action: Schema.Literal("opened"),
    /** What the opened thread was waiting for. */
    attention: Schema.Literals([
      "approval",
      "input",
      "request",
      "limited",
      "failed",
      "woke",
      "done",
    ]),
    entryPoint: Schema.Literals(["shortcut", "command_palette", "chip"]),
  }),
  Schema.Struct({
    feature: Schema.Literal("next-unread-thread"),
    action: Schema.Literal("nothing_waiting"),
    entryPoint: Schema.Literals(["shortcut", "command_palette", "chip"]),
  }),
  Schema.Struct({
    feature: Schema.Literal("desktop-update-notice"),
    action: Schema.Literals(["notice_shown", "release_notes_opened"]),
  }),
  Schema.Struct({
    feature: Schema.Literal("project-actions"),
    action: Schema.Literal("run"),
    /** Where the action came from: saved in styal, the project's styal.json, or a local edit of one. */
    actionSource: Schema.Literals(["local", "file", "override"]),
    /** The project file in effect at the project root, so adoption of styal.json and t3.json shows. */
    projectFile: Schema.Literals(["styal.json", "t3.json", "none"]),
  }),
  Schema.Struct({
    feature: Schema.Literal("pull-request-bypass-merge"),
    action: Schema.Literal("merge"),
    outcome: Schema.Literals(["success", "failure"]),
  }),
  Schema.Struct({
    feature: Schema.Literal("incoming-share-thread"),
    action: Schema.Literal("added"),
    outcome: Schema.Literals(["success", "failure"]),
  }),
  ReportedClientSettingsSnapshot,
  ReportedMobileSettingsSnapshot,
]);
export type ForkClientUsageInput = typeof ForkClientUsageInput.Type;
