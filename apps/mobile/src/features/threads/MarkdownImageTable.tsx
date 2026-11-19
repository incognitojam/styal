import { useContext } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import type { MarkdownImageTableCell } from "../../lib/markdownImageTables";
import type {
  MarkdownImageRenderer,
  NativeMarkdownTextStyle,
} from "../../native/SelectableMarkdownText";
import {
  MarkdownImageAvailableWidthContext,
  MarkdownImageFillContext,
} from "./ThreadMarkdownImage";

const GAP = 10;

/**
 * An image-only table as equal-width thumbnails: header above, alt text below. More than three
 * columns wrap two per line. Frames on a line share its height and fit their image, so portrait
 * and landscape captures side by side line up.
 */
export function MarkdownImageTable(props: {
  readonly rows: ReadonlyArray<ReadonlyArray<MarkdownImageTableCell>>;
  readonly renderImage: MarkdownImageRenderer;
  readonly textStyle: NativeMarkdownTextStyle;
}) {
  const availableWidth = useContext(MarkdownImageAvailableWidthContext);
  const columns = Math.max(...props.rows.map((cells) => cells.length));
  const perLine = columns > 3 ? 2 : columns;
  const cellWidth =
    availableWidth > 0 ? Math.floor((availableWidth - GAP * (perLine - 1)) / perLine) : 0;
  // Headers sit over their column once, unless wrapping breaks the columns apart.
  const headersOnEveryLine = perLine < columns;
  const lines = props.rows.flatMap((cells, rowIndex) =>
    Array.from({ length: Math.ceil(cells.length / perLine) }, (_, index) => ({
      key: `${rowIndex}:${index}`,
      cells: cells
        .slice(index * perLine, (index + 1) * perLine)
        .map((cell, column) => ({ ...cell, key: `${rowIndex}:${index * perLine + column}` })),
      headers: headersOnEveryLine || rowIndex === 0,
    })),
  );
  return (
    <View style={{ gap: 14, marginTop: 8, marginBottom: 12 }}>
      {lines.map((line) => (
        <View key={line.key} style={{ flexDirection: "row", gap: GAP }}>
          {line.cells.map((cell) => (
            <View
              key={cell.key}
              style={{ width: cellWidth || undefined, flex: cellWidth ? 0 : 1, gap: 6 }}
            >
              {line.headers && cell.header ? (
                <Text
                  selectable
                  numberOfLines={2}
                  style={{
                    color: props.textStyle.strongColor,
                    fontFamily: props.textStyle.boldFontFamily,
                    fontSize: props.textStyle.fontSize * 0.875,
                  }}
                >
                  {cell.header}
                </Text>
              ) : null}
              <View style={{ flexGrow: 1 }}>
                <MarkdownImageAvailableWidthContext value={cellWidth}>
                  <MarkdownImageFillContext value>
                    {cell.image ? props.renderImage(cell.image) : null}
                  </MarkdownImageFillContext>
                </MarkdownImageAvailableWidthContext>
              </View>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}
