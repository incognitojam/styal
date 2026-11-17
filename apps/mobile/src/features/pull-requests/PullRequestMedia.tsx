import { pullRequestImageWidth } from "@t3tools/client-runtime/pull-request-image-preview";
import { PixelRatio, useWindowDimensions } from "react-native";
import { PullRequestLazyImage, PullRequestMediaVisibleContext } from "./PullRequestImageVisibility";
import { createContext, useContext, useState, useEffect } from "react";
import {
  pullRequestMediaSource,
  pullRequestImageSource,
  type PullRequestMediaLocation,
} from "./pullRequestMediaSource";
import { useFilePreviewGallery } from "../../components/ui/FilePreviewGallery";
import {
  SOURCE_CONTROL_MEDIA_ASSET,
  type AssetResource,
  type AssetImagePreview,
} from "@t3tools/contracts";

import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { videoMimeType } from "@t3tools/shared/video";
import { Pressable, View } from "react-native";
import { Image } from "expo-image";
import { AppText } from "../../components/ui/AppText";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { assetImageCacheKey } from "../../lib/assetImageSource";
import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import { VideoAttachmentTile } from "../../components/VideoAttachmentTile";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/ui/VideoPreviewModal";
import { ThreadMarkdownImageView } from "../threads/ThreadMarkdownImage";
import {
  FilePreviewModal,
  type FilePreviewSource,
  type FilePreviewItem,
} from "../../components/ui/FilePreviewModal";

export { PullRequestMediaVisibleContext } from "./PullRequestImageVisibility";

export const PullRequestMediaContext = createContext<PullRequestMediaLocation | null>(null);

export function usePullRequestMediaUrl(
  url: string,
  enabled = true,
  imagePreview?: AssetImagePreview,
) {
  const context = useContext(PullRequestMediaContext);
  const fetchUrl = sourceControlClients.mediaUrl(url)?.fetchUrl;
  const resource: AssetResource | null =
    context && fetchUrl
      ? {
          _tag: SOURCE_CONTROL_MEDIA_ASSET,
          cwd: context.cwd,
          ...(context.repository ? { repository: context.repository } : {}),
          url: fetchUrl,
          ...(imagePreview ? { imagePreview } : {}),
        }
      : null;
  const asset = useAssetUrlState(context?.environmentId ?? null, enabled ? resource : null);
  const refresh = useRefreshAssetUrl(context?.environmentId ?? null, resource);
  return {
    uri: !enabled ? null : asset._tag === "Success" ? asset.url : resource ? null : url,
    cacheKey: context && resource ? assetImageCacheKey(context.environmentId, resource) : undefined,
    unavailable: resource !== null && asset._tag === "Failure",
    source: pullRequestMediaSource(url, context),
    resolvePlaybackUri: resource ? async () => (await refresh()) ?? null : undefined,
  };
}

export function usePullRequestImageUrl(url: string, enabled = true) {
  const context = useContext(PullRequestMediaContext);
  const screen = useWindowDimensions();
  const fetchUrl = sourceControlClients.mediaUrl(url)?.fetchUrl;
  const preview =
    fetchUrl && !/\.(?:gif|svg)(?:[?#]|$)/i.test(fetchUrl)
      ? { width: pullRequestImageWidth(screen.width, PixelRatio.get()) }
      : undefined;
  const resource: AssetResource | null =
    context && fetchUrl && preview
      ? {
          _tag: SOURCE_CONTROL_MEDIA_ASSET,
          cwd: context.cwd,
          ...(context.repository ? { repository: context.repository } : {}),
          url: fetchUrl,
          imagePreview: { width: 64 },
        }
      : null;
  const tiny = useAssetUrlState(context?.environmentId ?? null, enabled ? resource : null);
  const media = usePullRequestMediaUrl(url, enabled, preview);
  const tinyUrl = tiny._tag === "Success" && tiny.imagePreview ? tiny.url : null;
  const [readyTiny, setReadyTiny] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Warm the tiny image cache before handing it to the native placeholder renderer.
  useEffect(() => {
    if (!tinyUrl) return;
    let cancelled = false;
    void Image.prefetch(tinyUrl, { cachePolicy: "memory-disk" })
      .catch(() => false)
      .finally(() => {
        if (!cancelled) setReadyTiny(tinyUrl);
      });
    return () => {
      cancelled = true;
    };
  }, [tinyUrl]);
  return {
    ...media,
    reserveFrame: preview !== undefined,
    placeholderUri: tinyUrl !== null && readyTiny === tinyUrl ? tinyUrl : undefined,
  };
}

type PullRequestMediaProps = {
  readonly url: string;
  readonly kind: "image" | "video" | "unknown";
  readonly caption?: string;
  readonly compact?: boolean;
};

export function PullRequestMedia(props: PullRequestMediaProps) {
  return props.kind === "image" ? (
    <PullRequestLazyImage key={props.url}>
      {(enabled) => <PullRequestImageContent {...props} enabled={enabled} />}
    </PullRequestLazyImage>
  ) : (
    <PullRequestVideoContent {...props} />
  );
}

function PullRequestImageContent(props: PullRequestMediaProps & { enabled: boolean }) {
  const media = usePullRequestImageUrl(props.url, props.enabled);
  return <PullRequestMediaContent {...props} media={media} />;
}

function PullRequestVideoContent(props: PullRequestMediaProps) {
  const media = usePullRequestMediaUrl(props.url);
  return <PullRequestMediaContent {...props} media={media} />;
}

function PullRequestMediaContent(
  props: PullRequestMediaProps & {
    media: ReturnType<typeof usePullRequestMediaUrl> & {
      placeholderUri?: string | undefined;
      reserveFrame?: boolean | undefined;
    };
  },
) {
  const media = props.media;
  const visible = useContext(PullRequestMediaVisibleContext);
  const context = useContext(PullRequestMediaContext);
  const withGallery = useFilePreviewGallery();
  const [image, setImage] = useState<FilePreviewSource | null>(null);
  const [video, setVideo] = useState<VideoPreviewSource | null>(null);
  const name = props.caption || new URL(props.url).pathname.split("/").pop() || "Attachment";
  if (props.kind === "image")
    return (
      <>
        <ThreadMarkdownImageView
          reserveFrame={media.reserveFrame}
          placeholderUri={media.placeholderUri}
          uri={media.uri}
          sourceKey={props.url}
          cacheKey={media.cacheKey}
          unavailable={media.unavailable}
          alt={name}
          onViewOriginal={() =>
            setImage({ ...pullRequestImageSource(props.url, context), previewImage: false, name })
          }
          onPressPreview={(source) =>
            setImage(
              withGallery({
                ...pullRequestImageSource(props.url, context),
                name,
                sourceIdentifier: source.sourceIdentifier,
              }),
            )
          }
        />
        <FilePreviewModal source={image} onRequestClose={() => setImage(null)} />
      </>
    );
  return (
    <View style={props.compact ? { width: 176 } : undefined}>
      {props.compact ? (
        <VideoAttachmentTile
          name={name}
          sourceIdentifier={props.url}
          thumbnailSource={visible ? media.uri : null}
          style={{ width: 176, height: 112, borderRadius: 16 }}
          onPress={() =>
            setVideo({
              type: "media",
              ...media.source,
              name,
              mimeType:
                videoMimeType({ name: props.url.split(/[?#]/)[0] ?? props.url, mimeType: "" }) ??
                "video/mp4",
            })
          }
        />
      ) : (
        <MediaVideoPlayer
          uri={media.uri}
          unavailable={media.unavailable}
          name={name}
          thumbnailKey={props.url}
          thumbnailVisible={visible}
          visible={visible}
          resolvePlaybackUri={media.resolvePlaybackUri}
        />
      )}
      <VideoPreviewModal source={video} onRequestClose={() => setVideo(null)} />
    </View>
  );
}

type PullRequestImageAttachmentProps = {
  readonly url: string;
  readonly caption: string;
  readonly source: FilePreviewItem;
  readonly gallery: readonly FilePreviewItem[];
};

export function PullRequestImageAttachment(props: PullRequestImageAttachmentProps) {
  return (
    <PullRequestLazyImage key={props.url}>
      {(enabled) => <PullRequestImageAttachmentContent {...props} enabled={enabled} />}
    </PullRequestLazyImage>
  );
}

function PullRequestImageAttachmentContent(
  props: PullRequestImageAttachmentProps & { enabled: boolean },
) {
  const media = usePullRequestImageUrl(props.url, props.enabled);
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const failed = media.unavailable || (media.uri !== null && failedUri === media.uri);
  return (
    <>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={failed ? "View original" : `View attachment: ${props.caption}`}
        onPress={() =>
          setPreview(
            failed
              ? { ...props.source, previewImage: false }
              : { ...props.source, gallery: props.gallery },
          )
        }
        className="gap-2 active:opacity-70"
        style={{ width: 176 }}
      >
        <View className="overflow-hidden rounded-2xl border border-border-subtle bg-grouped-card">
          <Image
            onError={() => setFailedUri(media.uri)}
            placeholder={media.placeholderUri ? { uri: media.placeholderUri } : undefined}
            source={media.uri ? { uri: media.uri, cacheKey: media.cacheKey } : null}
            style={{ width: 174, height: 112 }}
            contentFit="contain"
            cachePolicy="memory-disk"
          />
        </View>
        <AppText numberOfLines={1} className="text-xs text-foreground-muted">
          {props.caption}
        </AppText>
      </Pressable>
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </>
  );
}
