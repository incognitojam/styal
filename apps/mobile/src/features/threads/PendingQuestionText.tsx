import { useNavigation } from "@react-navigation/native";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { resolveMarkdownLinkPresentation } from "@t3tools/mobile-markdown-text/links";
import { useCallback, useMemo } from "react";

import { fileRoutePathSegments, resolveWorkspaceRelativeFilePath } from "../files/filePath";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { resolveScaledTextRole } from "../../lib/appearancePreferences";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useFontFamily } from "../../lib/useFontFamily";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";

export function PendingQuestionText(props: {
  readonly text: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string | null;
}) {
  const navigation = useNavigation();
  const theme = useUniwindTheme();
  const { appearance } = useAppearancePreferences();
  const fontFamily = useFontFamily("regular");
  const boldFontFamily = useFontFamily("bold");
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
      if (presentation.href) void tryOpenExternalUrl(presentation.href, "markdown-link");
    },
    [navigation, props.threadRef, props.workspaceRoot],
  );

  return (
    <SelectableMarkdownText
      markdown={props.text}
      textStyle={textStyle}
      preserveSoftBreaks
      parseRawHtml={false}
      onLinkPress={onLinkPress}
    />
  );
}
