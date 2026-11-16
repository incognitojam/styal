import { pullRequestImageWidth } from "@t3tools/client-runtime/pull-request-image-preview";
import { PixelRatio, useWindowDimensions } from "react-native";
import { MarkdownImageAvailableWidthContext } from "../threads/ThreadMarkdownImage";
import { PullRequestLazyImage, PullRequestMediaVisibleContext } from "./PullRequestImageVisibility";
import { createContext, useContext, useState } from "react";
import {
  pullRequestMediaSource,
  pullRequestImageSource,
  type PullRequestMediaLocation,
} from "./pullRequestMediaSource";
import { useFilePreviewGallery } from "../../components/ui/FilePreviewGallery";
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

export function usePullRequestMediaUrl(url: string, enabled = true, imageWidth?: number) {
  const context = useContext(PullRequestMediaContext);
  const source = pullRequestMediaSource(url, context);
  const screen = useWindowDimensions();
  const original = "resource" in source ? (source.resource ?? null) : null;
  const resource = original && imageWidth && !/\.(?:gif|svg)(?:[?#]|$)/i.test(url) ? { ...original, imagePreview: { width: pullRequestImageWidth(screen.width, PixelRatio.get()) } } : original;
  const tinyResource = resource && "imagePreview" in resource ? { ...resource, imagePreview: { width: 64 as const } } : null;
  const tiny = useAssetUrlState(context?.environmentId ?? null, enabled ? tinyResource : null);
  const asset = useAssetUrlState(context?.environmentId ?? null, enabled ? resource : null);
  const refresh = useRefreshAssetUrl(context?.environmentId ?? null, resource);
  return {
    placeholderUri: tiny._tag === "Success" && tiny.imagePreview ? tiny.url : undefined,
    uri: !enabled ? null : asset._tag === "Success" ? asset.url : resource ? null : url,
    cacheKey: context && resource ? assetImageCacheKey(context.environmentId, resource) : undefined,
    unavailable: resource !== null && asset._tag === "Failure",
    source,
    resolvePlaybackUri: resource ? async () => (await refresh()) ?? null : undefined,
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
      {(enabled) => <PullRequestMediaContent {...props} enabled={enabled} />}
    </PullRequestLazyImage>
  ) : (
    <PullRequestMediaContent {...props} enabled />
  );
}

function PullRequestMediaContent(props: PullRequestMediaProps & { enabled: boolean }) {
  const availableWidth = useContext(MarkdownImageAvailableWidthContext);
  const media = usePullRequestMediaUrl(
    props.url,
    props.enabled,
    props.kind === "image" ? availableWidth || 360 : undefined,
  );
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
          placeholderUri={media.placeholderUri}
          uri={media.uri}
          sourceKey={props.url}
          cacheKey={media.cacheKey}
          unavailable={media.unavailable}
          alt={name}
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
  const media = usePullRequestMediaUrl(props.url, props.enabled, 174);
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  return (
    <>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`View attachment: ${props.caption}`}
        onPress={() => setPreview({ ...props.source, gallery: props.gallery })}
        className="gap-2 active:opacity-70"
        style={{ width: 176 }}
      >
        <View className="overflow-hidden rounded-2xl border border-border-subtle bg-grouped-card">
          <Image
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
