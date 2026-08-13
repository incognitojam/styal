import React, { type ReactNode } from "react";
import type { Components } from "react-markdown";

const STABLE_RENDERER_KEYS = [
  "p",
  "blockquote",
  "li",
  "input",
  "a",
  "code",
  "table",
  "details",
  "pre",
] as const;

/** Keep element types stable so ordinary UI updates do not remount selected text. */
export function createStableMarkdownComponents(readLatest: () => Components): Components {
  const stable = Object.fromEntries(
    STABLE_RENDERER_KEYS.map((key) => [
      key,
      (props: object) => {
        const renderer = readLatest()[key];
        return typeof renderer === "function"
          ? (renderer as (rendererProps: object) => ReactNode)(props)
          : React.createElement(key, props);
      },
    ]),
  ) as Components;

  stable.img = (props) => React.createElement(readLatest().img ?? "img", props);
  return stable;
}
