import { observeResize } from "../../lib/observeResize";
import {
  fetchPullRequestPlaceholder,
  pullRequestImageWidth,
} from "@t3tools/client-runtime/pull-request-image-preview";
import { MISSING_FILE_ACCESS_MESSAGE } from "@t3tools/client-runtime/state/assets";
import { mediaFileReference, mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import type {
  AssetImagePreview,
  AssetResource,
  EnvironmentId,
  SOURCE_CONTROL_MEDIA_ASSET,
} from "@t3tools/contracts";
import { ImageIcon, TriangleAlertIcon } from "lucide-react";
import {
  createContext,
  memo,
  use,
  useState,
  useEffect,
  useRef,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "../../assets/assetUrls";
import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { MediaActions, type MediaActionSource } from "../media/MediaActions";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { markdownImageGallery, markdownImageItems } from "./markdownImageGallery";

const CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME = "max-w-[min(100%,30rem)]";
const CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME = cn(
  "max-h-[30rem]",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
);
const CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME = "inline-block!";
const CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME = "rounded-lg border border-border/40";
const CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME = cn(
  "h-auto w-auto object-contain",
  CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
);

export function markdownImageCopy(alt: string, src: string, title: string | undefined): string {
  const escapedAlt = alt.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
  const titleSuffix =
    title === undefined ? "" : ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return `![${escapedAlt}](${src}${titleSuffix})`;
}

/**
 * `maxHeightRem` folds a height cap into the width bound: `max-height` alone
 * would not feed back through `aspect-ratio` once `width` is definite, so a
 * tall image would keep a box wider than the picture it draws.
 */
export function authoredImageSizeStyle(
  width: string | number | undefined,
  height: string | number | undefined,
  maxHeightRem = 30,
): CSSProperties | undefined {
  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  const hasWidth = Number.isFinite(parsedWidth) && parsedWidth > 0;
  const hasHeight = Number.isFinite(parsedHeight) && parsedHeight > 0;
  if (hasWidth && hasHeight) {
    return {
      width: parsedWidth,
      height: "auto",
      aspectRatio: `${parsedWidth} / ${parsedHeight}`,
      maxWidth: `min(100%, 30rem, ${(maxHeightRem * parsedWidth) / parsedHeight}rem)`,
    };
  }
  if (hasWidth) return { maxWidth: `min(100%, 30rem, ${parsedWidth}px)` };
  if (hasHeight) return { maxHeight: `min(30rem, ${parsedHeight}px)` };
  return undefined;
}

const CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME = cn(
  CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
  CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
);
export const MarkdownLinkContext = createContext(false);
/** The thread's workspace mutation id, so a host image the agent rewrites gets a fresh URL. */
export const WorkspaceMutationIdContext = createContext<string | null | undefined>(undefined);

function expandableMarkdownImageProps(
  onImageExpand: ((preview: ExpandedImagePreview) => void) | undefined,
  alt: string,
) {
  if (!onImageExpand) return {};
  const previewName = alt.trim() || "image";
  const expand = (event: ReactMouseEvent | ReactKeyboardEvent) => {
    if (event.currentTarget.closest("a")) return;
    event.preventDefault();
    event.stopPropagation();
    const item = markdownImageItems.get(event.currentTarget);
    if (item) onImageExpand(markdownImageGallery(event.currentTarget, item));
  };
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `Preview ${previewName}`,
    onClick: expand,
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") expand(event);
    },
  };
}

function ChatMarkdownMediaUnavailableLabel(props: {
  readonly alt: string;
  readonly kind?: "image" | "video" | "audio" | undefined;
  readonly detail?: string | undefined;
}) {
  const label =
    props.kind === "audio"
      ? "Audio unavailable"
      : props.kind === "video"
        ? "Video unavailable"
        : "Image unavailable";
  return (
    <span data-thread-find-ignore className="inline-flex items-center gap-1.5">
      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      {[label, props.alt, props.detail].filter(Boolean).join(" · ")}
    </span>
  );
}

export function ChatMarkdownImageFallback(props: {
  readonly alt: string;
  readonly copyMarkdown?: string | undefined;
  readonly kind?: "image" | "video" | "audio";
  readonly actionsSource?: MediaActionSource | undefined;
  readonly detail?: string | undefined;
  readonly onViewOriginal?: (() => void) | undefined;
}) {
  const content = (
    <span
      data-markdown-copy={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        "rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground",
      )}
    >
      <ChatMarkdownMediaUnavailableLabel alt={props.alt} kind={props.kind} detail={props.detail} />
      {props.onViewOriginal ? (
        <button type="button" onClick={props.onViewOriginal}>
          View original
        </button>
      ) : null}
    </span>
  );
  return props.actionsSource ? (
    <MediaActions source={props.actionsSource}>{content}</MediaActions>
  ) : (
    content
  );
}

const CHAT_MARKDOWN_IMAGE_FRAME_CLASS_NAME = cn(
  "aspect-video w-full overflow-hidden bg-muted/60",
  CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
  CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
);

/**
 * Callers key this on the file's identity, not its URL: a re-signed URL for
 * the same file keeps the decoded image on screen while the new bytes arrive,
 * and a different file starts from the slot again.
 */
export function ChatMarkdownImage(props: {
  readonly src: string | null;
  readonly placeholderSrc?: string | undefined;
  readonly sourceFailed?: boolean | undefined;
  readonly onViewOriginal?: (() => void) | undefined;
  readonly unavailableDetail?: string | undefined;
  readonly alt: string;
  readonly copyMarkdown: string | undefined;
  readonly standalone: boolean;
  readonly reserveFrame?: boolean | undefined;
  readonly sourceDimensions?: { readonly width: number; readonly height: number } | undefined;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly imageProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
  readonly actionsSource: MediaActionSource;
  readonly originalUrl?: string | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = props.src ?? loadedSrc;
  const failed = props.sourceFailed === true || (src !== null && failedSrc === src);
  const settled = src !== null && !failed && (!props.standalone || loadedSrc !== null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [tinySize, setTinySize] = useState<{ width: number; height: number } | null>(null);
  const framed = props.reserveFrame || !settled;
  const size = props.sourceDimensions ?? tinySize ?? naturalSize;
  const authoredRatio =
    typeof props.style?.aspectRatio === "string"
      ? props.style.aspectRatio.split("/").map(Number)
      : null;
  const ratio =
    authoredRatio?.[0] && authoredRatio[1]
      ? authoredRatio[0] / authoredRatio[1]
      : size
        ? size.width / size.height
        : 16 / 10;
  const naturalWidth = props.sourceDimensions?.width ?? naturalSize?.width;
  const bounds = [
    "100%",
    "30rem",
    `${30 * ratio}rem`,
    ...(naturalWidth ? [`${Math.max(3, naturalWidth)}px`] : []),
    ...(typeof props.style?.width === "number" ? [`${props.style.width}px`] : []),
    ...(props.style?.maxWidth ? [props.style.maxWidth] : []),
  ];
  const frameStyle = props.reserveFrame
    ? {
        ...props.style,
        width: "100%",
        height: "auto",
        aspectRatio: String(ratio),
        maxWidth: `min(${bounds.join(", ")})`,
      }
    : props.style;
  // Cached images are complete before `onLoad` can fire.
  const markLoadedIfComplete = (image: HTMLImageElement | null) => {
    if (!image) return;
    if (image.complete && image.naturalWidth > 0) {
      setLoadedSrc(image.currentSrc || image.src);
      setNaturalSize(
        (current) => current ?? { width: image.naturalWidth, height: image.naturalHeight },
      );
    }
    markdownImageItems.set(image, {
      src,
      name: props.alt.trim() || "image",
      actionsSource: props.actionsSource,
      ...(props.originalUrl ? { originalUrl: props.originalUrl } : {}),
    });
  };
  const imageEvents = (loadingSrc: string) => ({
    onLoad: (event: React.SyntheticEvent<HTMLImageElement>) => {
      const image = event.currentTarget;
      setNaturalSize(
        (current) => current ?? { width: image.naturalWidth, height: image.naturalHeight },
      );
      setLoadedSrc(loadingSrc);
      setFailedSrc(null);
    },
    onError: () => {
      setFailedSrc(loadingSrc);
      setLoadedSrc(null);
    },
  });

  if (settled && !props.standalone) {
    return (
      <MediaActions source={props.actionsSource}>
        <img
          {...props.imageProps}
          ref={markLoadedIfComplete}
          src={src}
          alt={props.alt}
          data-markdown-copy={props.copyMarkdown}
          decoding="async"
          loading="lazy"
          draggable={false}
          className={cn(
            CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME,
            props.className,
            props.onImageExpand && "cursor-zoom-in",
          )}
          style={props.style}
          {...expandableMarkdownImageProps(props.onImageExpand, props.alt)}
          {...imageEvents(src)}
        />
      </MediaActions>
    );
  }
  if (!props.standalone) {
    return failed ? (
      <ChatMarkdownImageFallback
        alt={props.alt}
        copyMarkdown={props.copyMarkdown}
        actionsSource={props.actionsSource}
        detail={props.unavailableDetail}
        onViewOriginal={props.onViewOriginal}
      />
    ) : (
      <span
        id={props.imageProps?.id}
        data-markdown-copy={props.copyMarkdown}
        role="status"
        aria-label="Loading image"
        className={CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME}
      />
    );
  }
  return (
    <MediaActions source={props.actionsSource}>
      <span
        id={props.imageProps?.id}
        data-markdown-copy={props.copyMarkdown}
        className={cn(
          CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
          framed ? CHAT_MARKDOWN_IMAGE_FRAME_CLASS_NAME : undefined,
          framed ? "relative" : undefined,
        )}
        style={framed ? frameStyle : undefined}
        {...(failed
          ? { role: "alert" as const }
          : settled
            ? {}
            : { role: "status" as const, "aria-label": "Loading image" })}
      >
        {!failed && !settled && props.reserveFrame ? (
          <span
            aria-hidden
            className="absolute inset-0 flex items-center justify-center text-muted-foreground"
          >
            <ImageIcon className="size-6" />
          </span>
        ) : null}
        {props.placeholderSrc && !failed && !settled ? (
          <img
            src={props.placeholderSrc}
            alt=""
            aria-hidden
            onLoad={(event) => {
              const image = event.currentTarget;
              if (!naturalSize)
                setTinySize(
                  (current) =>
                    current ?? { width: image.naturalWidth, height: image.naturalHeight },
                );
            }}
            className="absolute inset-0 size-full object-contain blur-sm"
          />
        ) : null}
        {failed ? (
          <span className="flex size-full items-center justify-center p-2 text-center text-xs text-muted-foreground">
            <ChatMarkdownMediaUnavailableLabel alt={props.alt} detail={props.unavailableDetail} />
            {props.onViewOriginal ? (
              <button type="button" onClick={props.onViewOriginal}>
                View original
              </button>
            ) : null}
          </span>
        ) : src !== null ? (
          <img
            ref={markLoadedIfComplete}
            src={src}
            alt={props.alt}
            decoding="async"
            loading="lazy"
            draggable={false}
            {...props.imageProps}
            data-markdown-copy={props.copyMarkdown}
            className={
              props.reserveFrame
                ? cn(
                    "absolute inset-0 size-full object-contain",
                    !settled && "invisible",
                    props.onImageExpand && "cursor-zoom-in",
                  )
                : settled
                  ? cn(
                      CHAT_MARKDOWN_IMAGE_SIZE_CLASS_NAME,
                      props.className,
                      props.onImageExpand && "cursor-zoom-in",
                    )
                  : "invisible absolute inset-0 size-full"
            }
            style={settled && !props.reserveFrame ? props.style : undefined}
            {...expandableMarkdownImageProps(props.onImageExpand, props.alt)}
            {...imageEvents(src)}
          />
        ) : null}
      </span>
    </MediaActions>
  );
}

export function ChatMarkdownVideo(props: {
  readonly src: string | null;
  readonly alt: string;
  readonly copyMarkdown: string | undefined;
  readonly originalUrl?: string | undefined;
  readonly sourceFailed?: boolean | undefined;
  readonly style?: CSSProperties | undefined;
  readonly mediaIdentity?: string | undefined;
  readonly actionsSource?: MediaActionSource | undefined;
  readonly onRetry?: (() => Promise<unknown>) | undefined;
}) {
  return (
    <MediaVideoPlayer
      key={props.mediaIdentity ?? props.copyMarkdown ?? props.src}
      src={props.src}
      sourceFailed={props.sourceFailed}
      label={props.alt}
      originalUrl={props.originalUrl}
      style={props.style}
      copyMarkdown={props.copyMarkdown}
      className={cn(
        CHAT_MARKDOWN_MEDIA_LAYOUT_CLASS_NAME,
        CHAT_MARKDOWN_MEDIA_MAX_WIDTH_CLASS_NAME,
        "w-full",
      )}
      videoClassName={cn(
        CHAT_MARKDOWN_MEDIA_BOUNDS_CLASS_NAME,
        CHAT_MARKDOWN_MEDIA_FRAME_CLASS_NAME,
      )}
      onRetry={props.onRetry}
      actionsSource={props.actionsSource}
    />
  );
}

export const ChatMarkdownAssetImage = memo(function ChatMarkdownAssetImage(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: Extract<
    AssetResource,
    {
      readonly _tag:
        | "attachment"
        | "workspace-file"
        | "media-file"
        | typeof SOURCE_CONTROL_MEDIA_ASSET
        | "pull-request-file"
        | "tool-output-image";
    }
  >;
  readonly kind?: "image" | "video";
  readonly alt: string;
  readonly copyMarkdown?: string;
  readonly srcFragment?: string;
  readonly standalone?: boolean | undefined;
  readonly maxHeightRem?: number | undefined;
  readonly style?: CSSProperties | undefined;
  readonly className?: string | undefined;
  readonly imageProps?:
    | Omit<ComponentProps<"img">, "src" | "alt" | "className" | "style">
    | undefined;
  readonly originalUrl?: string | undefined;
  readonly framed?: boolean | undefined;
  readonly fallbackSrc?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly workspaceMutationId?: string | null | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const resource = props.resource;
  const [viewOriginal, setViewOriginal] = useState(false);
  const previewEnabled =
    !viewOriginal &&
    resource._tag === "github-media" &&
    props.kind !== "video" &&
    !/\.(?:gif|svg)(?:[?#]|$)/i.test(resource.url);
  const frame = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<AssetImagePreview["width"] | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe the visible frame to mint only the required preview size.
  useEffect(() => {
    const element = frame.current;
    if (!previewEnabled || !element) return;
    let visible = false;
    const measure = () => {
      if (!visible) return;
      const available = element.getBoundingClientRect().width;
      const chosen = pullRequestImageWidth(
        Math.max(available || 480, window.innerWidth),
        window.devicePixelRatio,
      );
      setWidth((previous) =>
        previous === null ? chosen : (Math.max(previous, chosen) as typeof chosen),
      );
    };
    const stopResize = observeResize(element, measure);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      measure();
    });
    intersection.observe(element);
    return () => {
      stopResize();
      intersection.disconnect();
    };
  }, [previewEnabled]);
  const inlineResource =
    previewEnabled && resource._tag === "github-media"
      ? width === null
        ? null
        : { ...resource, imagePreview: { width } }
      : resource;
  const threadWorkspaceMutationId = use(WorkspaceMutationIdContext);
  const workspaceMutationId = props.workspaceMutationId ?? threadWorkspaceMutationId;
  const placeholder = useAssetUrlState(
    props.environmentId,
    previewEnabled && width !== null && resource._tag === "github-media"
      ? { ...resource, imagePreview: { width: 64 } }
      : null,
  );
  const tinyUrl =
    placeholder._tag === "Success" && placeholder.imagePreview ? placeholder.url : null;
  const [tiny, setTiny] = useState<
    ({ url: string } & Awaited<ReturnType<typeof fetchPullRequestPlaceholder>>) | null
  >(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Fetch the tiny bitmap and its response metadata together, without downloading it twice.
  useEffect(() => {
    if (!tinyUrl) return;
    const controller = new AbortController();
    void fetchPullRequestPlaceholder(tinyUrl, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setTiny({ url: tinyUrl, ...value });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [tinyUrl]);
  const readyTiny = tiny?.url === tinyUrl ? tiny : null;
  const assetUrl = useAssetUrlState(
    props.environmentId,
    inlineResource,
    workspaceMutationId !== undefined &&
      props.kind !== "video" &&
      (resource._tag === "media-file" || resource._tag === "workspace-file")
      ? workspaceMutationId
      : undefined,
  );
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  const path =
    resource._tag === "media-file"
      ? resource.path
      : resource._tag === "workspace-file" && props.workspaceRoot
        ? `${props.workspaceRoot.replace(/[\\/]+$/, "")}/${resource.path}`
        : undefined;
  const reference = path
    ? mediaFileReference(path, props.workspaceRoot)
    : props.originalUrl
      ? mediaUrlReference(props.originalUrl)
      : undefined;
  const relativePath = reference?.kind === "file" ? reference.relativePath : undefined;
  const fallbackSrc =
    !previewEnabled && assetUrl._tag === "Failure" ? props.fallbackSrc : undefined;
  const src =
    assetUrl._tag === "Success"
      ? assetUrl.url + (props.srcFragment ?? "")
      : fallbackSrc === undefined
        ? null
        : fallbackSrc + (props.srcFragment ?? "");
  const knownSize = assetUrl._tag === "Success" ? assetUrl.imageDimensions : undefined;
  const maxHeightRem = props.maxHeightRem ?? 30;
  const style =
    props.style ??
    (knownSize
      ? authoredImageSizeStyle(knownSize.width, knownSize.height, maxHeightRem)
      : maxHeightRem !== 30
        ? { maxHeight: `${maxHeightRem}rem` }
        : undefined);
  const actionsSource: MediaActionSource = {
    kind: props.kind ?? "image",
    name: props.alt || (props.kind ?? "image"),
    src,
    ...(fallbackSrc === undefined
      ? {
          asset: { environmentId: props.environmentId, resource: inlineResource ?? resource },
          ...(previewEnabled
            ? { originalAsset: { environmentId: props.environmentId, resource } }
            : {}),
        }
      : {}),
    ...(reference ? { reference } : {}),
    ...(relativePath && (resource._tag === "media-file" || resource._tag === "workspace-file")
      ? {
          onOpenFile: () =>
            useRightPanelStore
              .getState()
              .openFile(
                { environmentId: props.environmentId, threadId: resource.threadId },
                relativePath,
              ),
        }
      : {}),
  };

  if (props.kind === "video") {
    return (
      <ChatMarkdownVideo
        src={src}
        sourceFailed={assetUrl._tag === "Failure" && fallbackSrc === undefined}
        alt={props.alt}
        copyMarkdown={props.copyMarkdown}
        originalUrl={props.originalUrl}
        style={props.style}
        mediaIdentity={JSON.stringify([props.environmentId, props.resource, props.srcFragment])}
        onRetry={refreshAssetUrl}
        actionsSource={actionsSource}
      />
    );
  }

  const image = (
    <ChatMarkdownImage
      key={JSON.stringify([props.environmentId, props.resource, props.srcFragment])}
      onViewOriginal={previewEnabled ? () => setViewOriginal(true) : undefined}
      placeholderSrc={readyTiny?.uri}
      src={src}
      sourceFailed={assetUrl._tag === "Failure" && fallbackSrc === undefined}
      unavailableDetail={
        assetUrl._tag === "Failure" &&
        assetUrl.reason === "missing-file-access" &&
        fallbackSrc === undefined
          ? MISSING_FILE_ACCESS_MESSAGE
          : undefined
      }
      alt={props.alt}
      copyMarkdown={props.copyMarkdown}
      standalone={previewEnabled || (props.standalone ?? true)}
      reserveFrame={previewEnabled}
      sourceDimensions={readyTiny?.sourceDimensions}
      className={cn(
        props.framed === false ? undefined : CHAT_MARKDOWN_WORKSPACE_IMAGE_CLASS_NAME,
        props.className,
      )}
      style={style}
      imageProps={props.imageProps}
      actionsSource={actionsSource}
      originalUrl={props.originalUrl}
      onImageExpand={props.onImageExpand}
    />
  );
  return previewEnabled ? (
    <span ref={frame} className="block max-w-full">
      {image}
    </span>
  ) : (
    image
  );
});
