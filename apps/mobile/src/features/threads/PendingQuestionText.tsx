import { markdownProseDirection, type TextDirection } from "@t3tools/shared/textDirection";
import { Platform } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";
import { useCallback, useMemo } from "react";

import { fileRoutePathSegments, resolveWorkspaceRelativeFilePath } from "../files/filePath";
import { resolveScaledTextRole } from "../../lib/appearancePreferences";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { FONT_FAMILIES } from "../../lib/fontFamilies";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useLiveThreadLinkLabels } from "../../state/entities";

export function PendingQuestionText(props: {
  readonly text: string;
  readonly setDirection?: TextDirection;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string | null;
}) {
  const navigation = useNavigation();
  const markdown = useLiveThreadLinkLabels(props.text, props.threadRef.environmentId);
  // Pull request links open in the app; other links open in the system browser.
  const openLink = useOpenPullRequest();
  const theme = useUniwindTheme();
  const { appearance } = useAppearancePreferences();
  const fontFamily = FONT_FAMILIES.regular;
  const boldFontFamily = FONT_FAMILIES.bold;
  const textStyle = useMemo(
    () => ({
      color: theme["--color-foreground"],
      strongColor: theme["--color-foreground"],
      mutedColor: theme["--color-foreground-muted"],
      linkColor: theme["--color-md-link"],
      inlineCodeColor: theme["--color-foreground-secondary"],
      codeColor: theme["--color-md-code-text"],
      codeBackgroundColor: theme["--color-md-code-bg"],
      codeBlockBackgroundColor: theme["--color-md-code-bg"],
      fileTextColor: theme["--color-foreground"],
      skillTextColor: theme["--color-foreground"],
      quoteMarkerColor: theme["--color-md-blockquote-border"],
      dividerColor: theme["--color-md-hr"],
      ...resolveScaledTextRole("body", appearance.baseFontSize),
      fontFamily,
      headingFontFamily: boldFontFamily,
      boldFontFamily,
    }),
    [theme, fontFamily, boldFontFamily, appearance.baseFontSize],
  );
  const onLinkPress = useCallback(
    (href: string) => {
      const presentation = resolveMarkdownLinkPresentation(href);
      if (presentation.kind === "file") {
        const path =
          (props.workspaceRoot
            ? resolveWorkspaceRelativeFilePath(presentation.path, props.workspaceRoot)
            : null) ?? presentation.path;
        navigation.navigate("ThreadFile", {
          environmentId: String(props.threadRef.environmentId),
          threadId: String(props.threadRef.threadId),
          path: fileRoutePathSegments(path),
          ...(presentation.line ? { line: String(presentation.line) } : {}),
        });
        return;
      }
      if (presentation.href) void openLink(presentation.href);
    },
    [navigation, openLink, props.threadRef, props.workspaceRoot],
  );

  return (
    <SelectableMarkdownText
      markdown={markdown}
      textStyle={textStyle}
      writingDirection={markdownProseDirection(markdown)}
      // Android aligns relative to each paragraph direction.
      textAlign={
        Platform.OS === "android" ? undefined : props.setDirection === "rtl" ? "right" : "left"
      }
      preserveSoftBreaks
      parseRawHtml={false}
      onLinkPress={onLinkPress}
    />
  );
}
