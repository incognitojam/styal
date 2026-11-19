import { useAtomValue } from "@effect/atom-react";
import { MISSING_FILE_ACCESS_MESSAGE } from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { Image } from "expo-image";
import { createContext, useContext, useEffect, useId, useState } from "react";
import { fetch } from "expo/fetch";
import { parse, SvgAst, type JsxAST } from "react-native-svg";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { useFilePreviewGallery } from "../../components/ui/FilePreviewGallery";
import { AppText as Text } from "../../components/ui/AppText";
import type { FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { MediaActionsMenu } from "../../components/MediaActionsMenu";
import { PresentationSource } from "../../components/ui/NativePresentation";
import { useMediaActions } from "../../state/mediaActions";
import type { MediaActionsSource } from "../../lib/mediaActionsSource";
import { useAssetUrlState } from "../../state/assets";
import { WorkspaceMutationIdContext } from "./workspaceMutationIdContext";
import { assetImageCacheKey } from "../../lib/assetImageSource";
import {
  MARKDOWN_IMAGE_MAX_WIDTH,
  type MarkdownImageDisplaySize,
  resolveMarkdownImageDisplaySize,
  resolveSvgImageSize,
} from "./markdownImageSize";

/** Use known feed width immediately; later image measurement would move already-positioned rows. */
export const MarkdownImageAvailableWidthContext = createContext(0);

/**
 * In a thumbnail row: the image reports its size, and the frame takes the line's height (once
 * known) and fills its cell, fitting the image inside, so a line's frames line up.
 */
export const MarkdownImageRowContext = createContext<{
  readonly height: number | null;
  readonly sizeKey: string;
  readonly reportSize: (
    key: string,
    size: { readonly width: number; readonly height: number },
  ) => void;
} | null>(null);

type ImageSize = { readonly width: number; readonly height: number };

class SvgLoadError extends Schema.TaggedError<SvgLoadError>()("SvgLoadError", {
  cause: Schema.Defect(),
}) {}

async function readSvgXml(uri: string, signal: AbortSignal): Promise<string> {
  if (uri.startsWith("data:image/svg+xml")) {
    const comma = uri.indexOf(",");
    if (comma < 0) throw new Error("SVG data URI has no content");
    const content = decodeURIComponent(uri.slice(comma + 1));
    return uri.slice(0, comma).includes(";base64")
      ? new TextDecoder().decode(
          Uint8Array.from(atob(content), (character) => character.charCodeAt(0)),
        )
      : content;
  }
  // expo/fetch, not the runtime HttpClient: it is the one that reads file:// URIs.
  const response = await fetch(uri, { signal });
  if (!response.ok && !(response.status === 0 && uri.startsWith("file://")))
    throw new Error(`SVG request failed: ${response.status}`);
  return response.text();
}

type SvgDocument = { readonly ast: JsxAST; readonly size: ImageSize | null };

// Feed rows unmount as they scroll away. Only parsed documents outlive their
// readers (for the row that scrolls back); a failed load is dropped with its last
// reader so the next mount fetches again.
const parsedSvgDocumentAtom = Atom.family((_uri: string) =>
  Atom.make<SvgDocument | null>(null).pipe(
    Atom.setIdleTTL(60_000),
    Atom.withLabel("mobile:thread-markdown-svg-parsed"),
  ),
);

const svgDocumentAtom = Atom.family((uri: string) =>
  Atom.make((get) => {
    const parsed = parsedSvgDocumentAtom(uri);
    const cached = get(parsed);
    if (cached !== null) return Effect.succeed(cached);
    return Effect.tryPromise({
      try: async (signal): Promise<SvgDocument> => {
        const xml = await readSvgXml(uri, signal);
        signal.throwIfAborted();
        const ast = parse(xml);
        if (!ast) throw new Error("SVG has no root element");
        return { ast, size: resolveSvgImageSize(ast.props) };
      },
      catch: (cause) => new SvgLoadError({ cause }),
    }).pipe(Effect.tap((document) => Effect.sync(() => get.set(parsed, document))));
  }).pipe(Atom.withLabel("mobile:thread-markdown-svg")),
);

const noSvgDocumentAtom = Atom.make(AsyncResult.initial<SvgDocument, SvgLoadError>());

export function ThreadMarkdownImageView(props: {
  readonly uri: string | null;
  readonly placeholderUri?: string | undefined;
  readonly sourceKey: string;
  readonly cacheKey?: string | undefined;
  readonly unavailable: boolean;
  readonly unavailableDetail?: string | undefined;
  readonly alt: string | null;
  readonly knownSize?: { readonly width: number; readonly height: number } | undefined;
  readonly reserveFrame?: boolean | undefined;
  readonly authoredWidth?: number | undefined;
  readonly sourceDimensions?: ImageSize | undefined;
  readonly format?: "svg";
  readonly actionsSource?: MediaActionsSource;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly onViewOriginal?: (() => void) | undefined;
}) {
  const withGallery = useFilePreviewGallery();
  const sourceIdentifier = useId();
  const mediaActions = useMediaActions(props.actionsSource);
  const contextWidth = useContext(MarkdownImageAvailableWidthContext);
  const row = useContext(MarkdownImageRowContext);
  const fill = row !== null;
  // Until the line's height is known, frames stretch to the tallest on their line.
  const grow = row !== null && row.height === null;
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const availableWidth =
    measuredWidth > 0 && contextWidth > 0
      ? Math.min(contextWidth, measuredWidth)
      : contextWidth || measuredWidth;
  const svg = useAtomValue(
    props.format === "svg" && props.uri !== null ? svgDocumentAtom(props.uri) : noSvgDocumentAtom,
  );
  const svgDocument = AsyncResult.isSuccess(svg) ? svg.value : null;
  // Keyed by source so a new source drops the previous image's decoded dimensions.
  const [decoded, setDecoded] = useState<{ sourceKey: string; size: ImageSize } | null>(null);
  const decodedSize =
    svgDocument?.size ?? (decoded?.sourceKey === props.sourceKey ? decoded.size : null);
  // A failure belongs to one URI; any URI change, including through null, retries.
  const [failure, setFailure] = useState({ uri: props.uri, failed: false });
  if (failure.uri !== props.uri) setFailure({ uri: props.uri, failed: false });

  const [tinySize, setTinySize] = useState<ImageSize | null>(null);
  const sourceSize =
    props.knownSize ??
    props.sourceDimensions ??
    (props.reserveFrame ? tinySize : null) ??
    decodedSize ??
    null;
  const displaySize: MarkdownImageDisplaySize | null =
    sourceSize === null || availableWidth <= 0
      ? null
      : resolveMarkdownImageDisplaySize({
          sourceWidth: sourceSize.width,
          sourceHeight: sourceSize.height,
          availableWidth,
        });
  const failed =
    props.unavailable ||
    (props.uri !== null && failure.uri === props.uri && failure.failed) ||
    AsyncResult.isFailure(svg);
  const placeholderWidth: ViewStyle["width"] =
    availableWidth > 0 ? Math.min(availableWidth, MARKDOWN_IMAGE_MAX_WIDTH) : "100%";
  const ratio = sourceSize ? sourceSize.width / sourceSize.height : 16 / 10;
  const cap = Math.min(
    MARKDOWN_IMAGE_MAX_WIDTH,
    480 * ratio,
    props.authoredWidth ??
      props.knownSize?.width ??
      props.sourceDimensions?.width ??
      decodedSize?.width ??
      Infinity,
  );
  const naturalFrameStyle: ViewStyle = props.reserveFrame
    ? {
        width: availableWidth > 0 ? Math.min(availableWidth, cap) : "100%",
        maxWidth: cap,
        aspectRatio: ratio,
      }
    : (displaySize ?? { width: placeholderWidth, aspectRatio: 16 / 9 });
  const frameStyle: ViewStyle = row
    ? row.height !== null
      ? { width: "100%", height: row.height }
      : {
          width: "100%",
          flexGrow: 1,
          minHeight: displaySize?.height ?? (availableWidth > 0 ? (availableWidth * 9) / 16 : 0),
        }
    : naturalFrameStyle;
  const rowImageSize =
    row && displaySize && row.height !== null && displaySize.height > row.height
      ? { width: (displaySize.width * row.height) / displaySize.height, height: row.height }
      : displaySize;
  const reportRowSize = row?.reportSize;
  const rowSizeKey = row?.sizeKey;
  const sourceWidth = sourceSize?.width;
  const sourceHeight = sourceSize?.height;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the thumbnail row this image's size, which sets every tile's height on its line
  useEffect(() => {
    if (reportRowSize && rowSizeKey && sourceWidth && sourceHeight) {
      reportRowSize(rowSizeKey, { width: sourceWidth, height: sourceHeight });
    }
  }, [reportRowSize, rowSizeKey, sourceWidth, sourceHeight]);

  return (
    <View
      onLayout={(event) => setMeasuredWidth(event.nativeEvent.layout.width)}
      style={{ alignSelf: "stretch", gap: 6, flexGrow: grow ? 1 : 0 }}
    >
      {props.uri === null || failed ? (
        <MediaActionsMenu media={mediaActions} style={grow ? { flexGrow: 1 } : undefined}>
          <Pressable
            accessibilityRole="imagebutton"
            onPress={failed ? props.onViewOriginal : undefined}
            accessibilityLabel={
              failed && props.onViewOriginal ? "View original" : (props.alt ?? "Markdown image")
            }
            accessibilityHint={
              mediaActions.actions.length > 0 ? "Touch and hold for media actions" : undefined
            }
            className="items-center justify-center rounded-[10px] bg-md-code-bg"
            style={frameStyle}
          >
            {props.placeholderUri && !failed ? (
              <Image
                source={{ uri: props.placeholderUri }}
                onLoad={(event) => {
                  if (!decodedSize) setTinySize((current) => current ?? event.source);
                }}
                blurRadius={8}
                style={StyleSheet.absoluteFill}
                contentFit="contain"
              />
            ) : null}
            {failed ? (
              <Text className="px-3 text-center text-xs text-foreground-muted">
                {props.unavailableDetail
                  ? `Image unavailable. ${props.unavailableDetail}`
                  : props.onViewOriginal
                    ? "Image unavailable. View original"
                    : "Image unavailable"}
              </Text>
            ) : (
              <AppActivityIndicator />
            )}
          </Pressable>
        </MediaActionsMenu>
      ) : (
        <PresentationSource
          identifier={sourceIdentifier}
          style={grow ? { flexGrow: 1 } : fill ? undefined : { alignSelf: "flex-start" }}
        >
          <MediaActionsMenu media={mediaActions} style={grow ? { flexGrow: 1 } : undefined}>
            <Pressable
              accessibilityRole="imagebutton"
              accessibilityLabel={props.alt ?? "Markdown image"}
              accessibilityHint={
                mediaActions.actions.length > 0 ? "Touch and hold for media actions" : undefined
              }
              onPress={() =>
                props.onPressPreview(
                  withGallery({
                    kind: "image",
                    uri: props.uri!,
                    name: props.actionsSource?.name ?? props.alt ?? "Image",
                    sourceIdentifier,
                    actionsSource: props.actionsSource,
                  }),
                )
              }
              style={grow ? { flexGrow: 1 } : fill ? undefined : { alignSelf: "flex-start" }}
            >
              <View
                className="items-center justify-center overflow-hidden rounded-[10px] bg-md-code-bg"
                style={frameStyle}
              >
                {props.format === "svg" ? (
                  <ThreadMarkdownSvg ast={svgDocument?.ast ?? null} />
                ) : (
                  <ThreadMarkdownImageRequest
                    key={props.sourceKey}
                    uri={props.uri}
                    cacheKey={props.cacheKey}
                    size={fill ? rowImageSize : null}
                    onLoad={(size) =>
                      // Only the first decode counts: later loads report the bitmap
                      // downsampled for the current frame (969 vs 970 wide), so keeping
                      // them resizes the frame, which reloads the image, and so on.
                      setDecoded((current) =>
                        current?.sourceKey === props.sourceKey
                          ? current
                          : { sourceKey: props.sourceKey, size },
                      )
                    }
                    placeholderUri={props.placeholderUri}
                    onPlaceholderLoad={(size) => {
                      if (!decodedSize) setTinySize((current) => current ?? size);
                    }}
                    onError={() => setFailure({ uri: props.uri, failed: true })}
                  />
                )}
              </View>
            </Pressable>
          </MediaActionsMenu>
        </PresentationSource>
      )}
      {props.alt ? (
        <Text selectable className="text-xs text-foreground-muted">
          {props.alt}
        </Text>
      ) : null}
    </View>
  );
}

function ThreadMarkdownImageRequest(props: {
  readonly onPlaceholderLoad: (size: ImageSize) => void;
  readonly placeholderUri?: string | undefined;
  readonly uri: string;
  readonly cacheKey: string | undefined;
  /** A fixed size the frame centres; otherwise the image fills the frame. */
  readonly size: ImageSize | null;
  readonly onLoad: (sourceSize: ImageSize) => void;
  readonly onError: () => void;
}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <>
      {props.placeholderUri && !loaded ? (
        <Image
          source={{ uri: props.placeholderUri }}
          contentFit="contain"
          blurRadius={8}
          style={StyleSheet.absoluteFill}
          onLoad={(event) => props.onPlaceholderLoad(event.source)}
        />
      ) : null}
      {/* A plain view takes the size: Android did not move the image view itself when its row grew. */}
      <View style={props.size ?? StyleSheet.absoluteFill}>
        <Image
          placeholderContentFit="contain"
          source={{ uri: props.uri, cacheKey: props.cacheKey }}
          contentFit="contain"
          cachePolicy="memory-disk"
          accessible={false}
          onLoad={(event) => {
            setLoaded(true);
            props.onLoad(event.source);
          }}
          onError={props.onError}
          style={[StyleSheet.absoluteFill, { opacity: loaded ? 1 : 0 }]}
        />
      </View>
      {loaded ? null : <ThreadMarkdownImageLoading />}
    </>
  );
}

function ThreadMarkdownImageLoading() {
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}
    >
      <Text className="text-xs text-foreground-muted">Loading image…</Text>
    </View>
  );
}

function ThreadMarkdownSvg(props: { readonly ast: JsxAST | null }) {
  return props.ast === null ? (
    <ThreadMarkdownImageLoading />
  ) : (
    <SvgAst ast={props.ast} override={{ width: "100%", height: "100%", accessible: false }} />
  );
}

export function ThreadMarkdownImage(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: Extract<
    AssetResource,
    { readonly _tag: "attachment" | "media-file" | "draft-workspace-file" | "tool-output-image" }
  >;
  readonly alt: string | null;
  readonly srcFragment?: string;
  readonly actionsSource?: MediaActionsSource;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const withGallery = useFilePreviewGallery();
  const workspaceMutationId = useContext(WorkspaceMutationIdContext);
  const assetUrl = useAssetUrlState(
    props.environmentId,
    props.resource,
    props.resource._tag === "media-file" ? workspaceMutationId : undefined,
  );
  const resourceKey =
    props.resource._tag === "attachment"
      ? `attachment:${props.resource.attachmentId}`
      : props.resource._tag === "tool-output-image"
        ? `tool-output:${props.resource.itemId}:${props.resource.index}`
        : `workspace:${props.resource.path}`;
  // The view keeps the first decoded size per key, so a file edited in place needs a
  // new key; a re-signed URL for the same revision must not get one.
  const sourceKey =
    assetUrl._tag === "Success" && assetUrl.fileRevision !== undefined
      ? `${resourceKey}@${assetUrl.fileRevision}`
      : resourceKey;

  return (
    <ThreadMarkdownImageView
      uri={assetUrl._tag === "Success" ? assetUrl.url + (props.srcFragment ?? "") : null}
      cacheKey={
        assetUrl._tag === "Success"
          ? assetImageCacheKey(props.environmentId, props.resource, assetUrl.fileRevision)
          : undefined
      }
      sourceKey={sourceKey}
      unavailable={assetUrl._tag === "Failure"}
      unavailableDetail={
        assetUrl._tag === "Failure" && assetUrl.reason === "missing-file-access"
          ? MISSING_FILE_ACCESS_MESSAGE
          : undefined
      }
      knownSize={assetUrl._tag === "Success" ? assetUrl.imageDimensions : undefined}
      format={
        (props.resource._tag === "media-file" || props.resource._tag === "draft-workspace-file") &&
        /\.svg$/i.test(props.resource.path)
          ? "svg"
          : undefined
      }
      alt={props.alt}
      actionsSource={props.actionsSource}
      onPressPreview={(source) => {
        const { uri: _uri, ...rest } = source as FilePreviewSource & { uri?: string };
        props.onPressPreview(
          withGallery({
            ...rest,
            gallery: undefined,
            environmentId: props.environmentId,
            resource: props.resource,
          }),
        );
      }}
    />
  );
}

export function ThreadMarkdownImageUnavailable(props: { readonly alt: string | null }) {
  return (
    <ThreadMarkdownImageView
      uri={null}
      sourceKey="unavailable"
      unavailable
      alt={props.alt}
      onPressPreview={() => undefined}
    />
  );
}
