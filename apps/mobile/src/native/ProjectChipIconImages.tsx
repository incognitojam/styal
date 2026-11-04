import type { ProjectIconColor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import { useRef, useSyncExternalStore } from "react";
import { Platform, View } from "react-native";
import Svg, { parse, Rect, Text, type JsxAST } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import { resolveSvgImageSize } from "../features/threads/markdownImageSize";
import { countGlyphs, projectIconColorClassNames, type ProjectChipTile } from "../lib/projectIcon";

const TILE_SIZE = 48;

type TileContent =
  | Exclude<ProjectChipTile, { readonly kind: "svg" }>
  | { readonly kind: "svg"; readonly ast: JsxAST };

interface PendingTile {
  readonly key: string;
  readonly glyph: TileContent;
  readonly promise: Promise<string>;
  readonly resolve: (uri: string) => void;
  readonly reject: () => void;
}

const tiles = new Map<string, PendingTile>();
let pendingTiles: ReadonlyArray<PendingTile> = [];
const listeners = new Set<() => void>();

export function projectGlyphKey(glyph: ProjectChipTile): string {
  switch (glyph.kind) {
    case "emoji":
      return JSON.stringify(["emoji", glyph.emoji]);
    case "monogram":
      return JSON.stringify(["monogram", glyph.text, glyph.color]);
    case "svg":
      return JSON.stringify(["svg", glyph.dataUrl]);
  }
}

function svgDataUrlAst(dataUrl: string): JsxAST {
  const comma = dataUrl.indexOf(",");
  const content = decodeURIComponent(dataUrl.slice(comma + 1));
  const xml = dataUrl.slice(0, comma).includes(";base64")
    ? new TextDecoder().decode(Uint8Array.from(atob(content), (char) => char.charCodeAt(0)))
    : content;
  const ast = parse(xml);
  if (!ast) throw new Error("SVG has no root element");
  return ast;
}

function decodeGlyphKey(key: string): TileContent {
  const [kind, text, color] = JSON.parse(key) as [string, string, ProjectIconColor];
  switch (kind) {
    case "emoji":
      return { kind: "emoji", emoji: text };
    case "svg":
      return { kind: "svg", ast: svgDataUrlAst(text) };
    default:
      return { kind: "monogram", text, color };
  }
}

function rasterize(key: string): Promise<string> {
  const existing = tiles.get(key);
  if (existing) return existing.promise;
  let glyph: TileContent;
  try {
    glyph = decodeGlyphKey(key);
  } catch (error) {
    return Promise.reject(error);
  }
  let resolve!: (uri: string) => void;
  let reject!: () => void;
  const promise = new Promise<string>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const tile = { key, glyph, promise, resolve, reject };
  tiles.set(key, tile);
  pendingTiles = [...pendingTiles, tile];
  queueMicrotask(notify);
  return promise;
}

function finish(tile: PendingTile, base64: string | undefined) {
  if (base64) {
    tile.resolve(`data:image/png;base64,${base64.replace(/\s/g, "")}`);
  } else {
    tile.reject();
  }
  pendingTiles = pendingTiles.filter((pending) => pending !== tile);
  notify();
}

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const projectGlyphImageAtom = Atom.family((key: string) =>
  Atom.make(Effect.tryPromise(() => rasterize(key))).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile-project-glyph-image:${key}`),
  ),
);

export function ProjectChipIconRasterizer() {
  const pending = useSyncExternalStore(subscribe, () => pendingTiles);
  return pending.map((tile) => <GlyphCapture key={tile.key} tile={tile} />);
}

function captureTile(svg: Svg, tile: PendingTile) {
  try {
    svg.toDataURL(
      (base64?: string) => finish(tile, base64),
      Platform.OS === "ios" ? { width: TILE_SIZE, height: TILE_SIZE } : undefined,
    );
  } catch {
    finish(tile, undefined);
  }
}

function GlyphCapture(props: { readonly tile: PendingTile }) {
  const started = useRef(false);
  const capture = (svg: Svg | null) => {
    if (!svg || started.current) return;
    started.current = true;
    requestAnimationFrame(() => captureTile(svg, props.tile));
  };
  const glyph = props.tile.glyph;
  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", left: -TILE_SIZE * 4, top: 0, opacity: 0 }}
    >
      <Svg
        {...(glyph.kind === "svg" ? svgRootProps(glyph.ast) : {})}
        ref={capture}
        width={TILE_SIZE}
        height={TILE_SIZE}
      >
        {glyph.kind === "svg" ? (
          glyph.ast.children
        ) : glyph.kind === "emoji" ? (
          <Text
            x={TILE_SIZE / 2}
            y={TILE_SIZE * 0.8}
            textAnchor="middle"
            fontSize={TILE_SIZE * 0.8}
          >
            {glyph.emoji}
          </Text>
        ) : (
          <MonogramTile text={glyph.text} color={glyph.color} />
        )}
      </Svg>
    </View>
  );
}

/** Scales the favicon into the tile; an SVG without a viewBox is sized by its width and height. */
function svgRootProps(ast: JsxAST) {
  const size = resolveSvgImageSize(ast.props);
  const viewBox =
    typeof ast.props.viewBox === "string"
      ? ast.props.viewBox
      : size && `0 0 ${size.width} ${size.height}`;
  return { ...ast.props, ...(viewBox ? { viewBox } : {}) };
}

function MonogramTile(props: { readonly text: string; readonly color: ProjectIconColor }) {
  const classNames = projectIconColorClassNames(props.color);
  const background = useResolveClassNames(classNames.background);
  const foreground = useResolveClassNames(`font-mono ${classNames.text}`);
  const fontSize = TILE_SIZE * (countGlyphs(props.text) === 1 ? 0.6 : 0.515625);
  return (
    <>
      <Rect
        width={TILE_SIZE}
        height={TILE_SIZE}
        rx={TILE_SIZE * 0.25}
        fill={String(background.backgroundColor)}
      />
      <Text
        x={TILE_SIZE / 2}
        y={TILE_SIZE / 2 + fontSize * 0.36}
        textAnchor="middle"
        fill={String(foreground.color)}
        fontFamily={typeof foreground.fontFamily === "string" ? foreground.fontFamily : undefined}
        fontWeight="700"
        fontSize={fontSize}
      >
        {props.text}
      </Text>
    </>
  );
}
