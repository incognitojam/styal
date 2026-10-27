import {
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type ClientSettingsSnapshot,
} from "@t3tools/contracts";

/** When this device last had its settings snapshot accepted by a server. */
export const CLIENT_SETTINGS_SNAPSHOT_STORAGE_KEY = "styal:client-settings-snapshot:v1";

const sameShortcut = (a: ClientSettings["snapShotShortcut"], b: typeof a) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * The current values of this device's preferences. Settings that hold free
 * text, identifiers or per-project data are reported only as `...Customized`
 * or a count; see `NOT_REPORTED` in the test for the rest.
 */
export function clientSettingsSnapshot(
  settings: ClientSettings,
  device: { readonly projectOrder: readonly string[] },
): ClientSettingsSnapshot {
  return {
    feature: "client-settings",
    action: "snapshot",
    sendShortcut: settings.sendShortcut,
    followUpBehavior: settings.followUpBehavior,
    composerRichTextEnabled: settings.composerRichTextEnabled,
    composerCollapseOnScroll: settings.composerCollapseOnScroll,
    persistComposerContextStrip: settings.persistComposerContextStrip,
    proactivePanelsEnabled: settings.proactivePanelsEnabled,
    showSkillsInSlashMenu: settings.showSkillsInSlashMenu,
    planModeEnabled: settings.planModeEnabled,
    contextWindowMeterEnabled: settings.contextWindowMeterEnabled,
    turnUsageEnabled: settings.turnUsageEnabled,
    turnUsageFigure: settings.turnUsageFigure,
    chatWidth: settings.chatWidth,
    wordWrap: settings.wordWrap,
    mathRenderingEnabled: settings.mathRenderingEnabled,
    timestampFormat: settings.timestampFormat,
    loadBalancingEnabled: settings.loadBalancingEnabled,
    legacySidebarEnabled: settings.legacySidebarEnabled,
    sidebarWorkingShelfEnabled: settings.sidebarWorkingShelfEnabled,
    sidebarThreadGrouping: settings.sidebarThreadGrouping,
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrideCount: Object.keys(settings.sidebarProjectGroupingOverrides)
      .length,
    sidebarProjectSortOrder: settings.sidebarProjectSortOrder,
    sidebarManualProjectOrderSaved: device.projectOrder.length > 0,
    sidebarThreadSortOrder: settings.sidebarThreadSortOrder,
    sidebarThreadTimestampMode: settings.sidebarThreadTimestampMode,
    sidebarThreadPreviewCount: settings.sidebarThreadPreviewCount,
    confirmThreadArchive: settings.confirmThreadArchive,
    confirmThreadDelete: settings.confirmThreadDelete,
    confirmThreadUnpin: settings.confirmThreadUnpin,
    notificationMode: settings.notificationMode,
    inAppNotificationsEnabled: settings.inAppNotificationsEnabled,
    completionSound: settings.completionSound,
    inputSound: settings.inputSound,
    approvalSound: settings.approvalSound,
    claudeStatusAlertsEnabled: settings.claudeStatusAlertsEnabled,
    openaiStatusAlertsEnabled: settings.openaiStatusAlertsEnabled,
    githubStatusAlertsEnabled: settings.githubStatusAlertsEnabled,
    appearanceContrast: settings.appearanceContrast,
    glassOpacity: settings.glassOpacity,
    panelAnimationDurationMs: settings.panelAnimationDurationMs,
    environmentIdentificationMode: settings.environmentIdentificationMode,
    fontSizeInterface: settings.fontSizeInterface,
    fontSizePrompt: settings.fontSizePrompt,
    fontSizeCode: settings.fontSizeCode,
    fontSizeTerminal: settings.fontSizeTerminal,
    fontFamilySansCustomized: settings.fontFamilySans !== "",
    fontFamilyComposerCustomized: settings.fontFamilyComposer !== "",
    fontFamilyCodeCustomized: settings.fontFamilyCode !== "",
    fontFamilyTerminalCustomized: settings.fontFamilyTerminal !== "",
    fontSmoothing: settings.fontSmoothing,
    diffColorScheme: settings.diffColorScheme,
    diffLayout: settings.diffLayout,
    diffFilesCollapsed: settings.diffFilesCollapsed,
    diffIgnoreWhitespace: settings.diffIgnoreWhitespace,
    browserLinkTarget: settings.browserLinkTarget,
    pullRequestLinksOpenInApp: settings.pullRequestLinksOpenInApp,
    browserAutoShowFloatingPreview: settings.browserAutoShowFloatingPreview,
    browserDefaultViewport: settings.browserDefaultViewport._tag,
    browserDefaultZoomFactor: settings.browserDefaultZoomFactor,
    browserDefaultAppearance: settings.browserDefaultAppearance,
    browserSearchEngine: settings.browserSearchEngine,
    browserCustomSearchUrlCustomized: settings.browserCustomSearchUrl !== "",
    browserProfileCount: settings.browserProfiles.length,
    browserDefaultProfileCustomized:
      settings.browserDefaultProfileId !== DEFAULT_BROWSER_PROFILE_ID,
    browserRecordingFrameRate: settings.browserRecordingFrameRate,
    browserRecordingShowKeyPresses: settings.browserRecordingShowKeyPresses,
    browserRecordingShowMousePresses: settings.browserRecordingShowMousePresses,
    confirmQuit: settings.confirmQuit,
    discordRichPresence: settings.discordRichPresence,
    snapShotEnabled: settings.snapShotEnabled,
    snapShotShortcutCustomized: !sameShortcut(
      settings.snapShotShortcut,
      DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    ),
    snapShotIncludeAccessibility: settings.snapShotIncludeAccessibility,
    snapShotPlaySound: settings.snapShotPlaySound,
    snapShotSound: settings.snapShotSound,
    snapShotFlash: settings.snapShotFlash,
    snapShotAnimations: settings.snapShotAnimations,
  };
}
