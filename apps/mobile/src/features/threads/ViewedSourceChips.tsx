import {
  foldViewedSources,
  viewedDocumentPagesLabel,
  viewedSourceLabel,
  type ViewedSource,
} from "@t3tools/client-runtime/work-log/presentation";
import { useState } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";

const FOLD_LIMIT = 3;

export function ViewedSourceChips(props: {
  readonly sources: ReadonlyArray<ViewedSource>;
  readonly iconColor: string | ColorValue;
  readonly onPressSource: (source: ViewedSource) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { visible, hiddenCount } = foldViewedSources(props.sources, FOLD_LIMIT, expanded);
  return (
    <View className="flex-row flex-wrap gap-1.5 pb-2">
      {visible.map((source) => {
        const pages = source.kind === "document" ? viewedDocumentPagesLabel(source.pages) : null;
        return (
          <Pressable
            key={source.kind === "document" ? source.path : source.url}
            accessibilityRole={source.kind === "document" ? "button" : "link"}
            className="max-w-full flex-row items-center gap-1.5 rounded-md border border-border px-2 py-1 active:opacity-70"
            onPress={() => props.onPressSource(source)}
          >
            <SymbolView
              name={source.kind === "document" ? "doc.text" : "globe"}
              size={13}
              tintColor={props.iconColor}
              type="monochrome"
            />
            <Text className="shrink text-[13px] text-foreground" numberOfLines={1}>
              {viewedSourceLabel(source)}
            </Text>
            {pages ? <Text className="text-[13px] text-foreground-muted">{pages}</Text> : null}
          </Pressable>
        );
      })}
      {props.sources.length > FOLD_LIMIT ? (
        <Pressable
          accessibilityRole="button"
          className="justify-center rounded-md px-2 py-1 active:opacity-70"
          onPress={() => setExpanded(!expanded)}
        >
          <Text className="text-[13px] text-foreground-muted">
            {expanded ? "Show less" : `+${hiddenCount} more`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
