import {
  foldViewedSources,
  viewedDocumentPagesLabel,
  viewedSearchKey,
  viewedSearchResultSite,
  viewedSourceLabel,
  type ViewedSource,
} from "@t3tools/client-runtime/work-log/presentation";
import { useState } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";

const FOLD_LIMIT = 3;
const CHIP_CLASS_NAME =
  "max-w-full flex-row items-center gap-1.5 rounded-md border border-border px-2 py-1";

function sourceSymbol(source: ViewedSource): AppSymbolName {
  return source.kind === "document"
    ? "doc.text"
    : source.kind === "page"
      ? "globe"
      : "magnifyingglass";
}

export function ViewedSourceChips(props: {
  readonly sources: ReadonlyArray<ViewedSource>;
  readonly iconColor: string | ColorValue;
  readonly onOpenLink: (href: string) => void;
  /** Opens the collapsed tool group, for a search chip whose search reported no results. */
  readonly onOpenGroup: (() => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openSearchKey, setOpenSearchKey] = useState<string | null>(null);
  const { visible, hiddenCount } = foldViewedSources(props.sources, FOLD_LIMIT, expanded);
  const openSearch = visible.find(
    (source): source is Extract<ViewedSource, { kind: "search" }> =>
      source.kind === "search" && viewedSearchKey(source.query) === openSearchKey,
  );
  return (
    <View className="gap-1.5 pb-2">
      <View className="flex-row flex-wrap gap-1.5">
        {visible.map((source) => {
          const searchKey = source.kind === "search" ? viewedSearchKey(source.query) : null;
          const key =
            source.kind === "document"
              ? source.path
              : source.kind === "page"
                ? source.url
                : `search:${searchKey}`;
          const pages = source.kind === "document" ? viewedDocumentPagesLabel(source.pages) : null;
          const resultCount = source.kind === "search" ? source.results.length : 0;
          const onPress =
            source.kind === "document"
              ? () => props.onOpenLink(source.path)
              : source.kind === "page"
                ? () => props.onOpenLink(source.url)
                : resultCount > 0
                  ? () => setOpenSearchKey(openSearchKey === searchKey ? null : searchKey)
                  : props.onOpenGroup;
          const content = (
            <>
              <SymbolView
                name={sourceSymbol(source)}
                size={13}
                tintColor={props.iconColor}
                type="monochrome"
              />
              <Text className="shrink text-[13px] text-foreground" numberOfLines={1}>
                {viewedSourceLabel(source)}
              </Text>
              {pages || resultCount > 0 ? (
                <Text className="text-[13px] text-foreground-muted">{pages ?? resultCount}</Text>
              ) : null}
            </>
          );
          return onPress ? (
            <Pressable
              key={key}
              accessibilityRole={source.kind === "page" ? "link" : "button"}
              className={`${CHIP_CLASS_NAME} active:opacity-70`}
              onPress={onPress}
            >
              {content}
            </Pressable>
          ) : (
            <View key={key} className={CHIP_CLASS_NAME}>
              {content}
            </View>
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
      {openSearch ? (
        <View className="gap-0.5">
          {openSearch.results.map((result) => (
            <Pressable
              key={result.url}
              accessibilityRole="link"
              className="flex-row items-center gap-1.5 px-1 py-1 active:opacity-70"
              onPress={() => props.onOpenLink(result.url)}
            >
              <SymbolView name="globe" size={13} tintColor={props.iconColor} type="monochrome" />
              <Text className="shrink text-[13px] text-foreground" numberOfLines={1}>
                {result.title ?? viewedSearchResultSite(result.url)}
              </Text>
              {result.title ? (
                <Text className="text-[13px] text-foreground-muted" numberOfLines={1}>
                  {viewedSearchResultSite(result.url)}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
