import { useCallback, useContext, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import type { MarkdownImageTableCell } from "../../lib/markdownImageTables";
import type {
  MarkdownImageRenderer,
  NativeMarkdownTextStyle,
} from "../../native/SelectableMarkdownText";
import { MarkdownImageAvailableWidthContext, MarkdownImageRowContext } from "./ThreadMarkdownImage";
import { resolveMarkdownImageRowHeight } from "./markdownImageSize";

const GAP = 10;

/**
 * An image-only table as equal-width thumbnails: header above, alt text below. More than three
 * columns wrap two per line. Tiles on a line share one height (see `resolveMarkdownImageRowHeight`)
 * and fit their image, centred, so portrait and landscape captures side by side line up.
 */
export function MarkdownImageTable(props: {
  readonly rows: ReadonlyArray<ReadonlyArray<MarkdownImageTableCell>>;
  readonly renderImage: MarkdownImageRenderer;
  readonly textStyle: NativeMarkdownTextStyle;
}) {
  const availableWidth = useContext(MarkdownImageAvailableWidthContext);
  const [sizes, setSizes] = useState<
    ReadonlyMap<string, { readonly width: number; readonly height: number }>
  >(new Map());
  const reportSize = useCallback(
    (key: string, size: { readonly width: number; readonly height: number }) =>
      setSizes((current) =>
        current.get(key)?.width === size.width && current.get(key)?.height === size.height
          ? current
          : new Map(current).set(key, size),
      ),
    [],
  );
  // Keyed by the image as well as its place, so a cell that changes image is measured again.
  const sizeKey = (cell: {
    readonly key: string;
    readonly image: { readonly href: string } | null;
  }) => (cell.image ? `${cell.key}|${cell.image.href}` : null);
  const columns = Math.max(...props.rows.map((cells) => cells.length));
  const perLine = columns > 3 ? 2 : columns;
  const cellWidth =
    availableWidth > 0 ? Math.floor((availableWidth - GAP * (perLine - 1)) / perLine) : 0;
  // Headers sit over their column once, unless wrapping breaks the columns apart.
  const headersOnEveryLine = perLine < columns;
  const lines = props.rows
    .flatMap((cells, rowIndex) =>
      Array.from({ length: Math.ceil(cells.length / perLine) }, (_, index) => ({
        key: `${rowIndex}:${index}`,
        cells: cells
          .slice(index * perLine, (index + 1) * perLine)
          .map((cell, column) => ({ ...cell, key: `${rowIndex}:${index * perLine + column}` })),
        headers: headersOnEveryLine || rowIndex === 0,
      })),
    )
    .map((line) => ({
      ...line,
      height: resolveMarkdownImageRowHeight(
        line.cells.flatMap((cell) => {
          const key = sizeKey(cell);
          return (key && sizes.get(key)) || [];
        }),
        cellWidth,
      ),
    }));
  const headerStyle = {
    color: props.textStyle.strongColor,
    fontFamily: props.textStyle.boldFontFamily,
    fontSize: props.textStyle.fontSize * 0.875,
  };
  return (
    <View style={{ gap: 14, marginTop: 8, marginBottom: 12 }}>
      {lines.map((line) => (
        // Headers get their own band, so a header that wraps does not push its image down.
        <View key={line.key} style={{ gap: 6 }}>
          {line.headers && line.cells.some((cell) => cell.header) ? (
            <View style={{ flexDirection: "row", gap: GAP }}>
              {line.cells.map((cell) => (
                <Text
                  key={cell.key}
                  selectable
                  numberOfLines={2}
                  style={[headerStyle, { width: cellWidth || undefined, flex: cellWidth ? 0 : 1 }]}
                >
                  {cell.header}
                </Text>
              ))}
            </View>
          ) : null}
          <View style={{ flexDirection: "row", gap: GAP }}>
            {line.cells.map((cell) => {
              const key = sizeKey(cell);
              return (
                <View
                  key={cell.key}
                  style={{ width: cellWidth || undefined, flex: cellWidth ? 0 : 1 }}
                >
                  <MarkdownImageAvailableWidthContext value={cellWidth}>
                    <MarkdownImageRowContext
                      value={key ? { height: line.height, sizeKey: key, reportSize } : null}
                    >
                      {cell.image ? props.renderImage(cell.image) : null}
                    </MarkdownImageRowContext>
                  </MarkdownImageAvailableWidthContext>
                </View>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}
