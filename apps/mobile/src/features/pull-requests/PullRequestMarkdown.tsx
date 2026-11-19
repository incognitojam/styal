import { PullRequestLazyImage } from "./PullRequestImageVisibility";
import {
  splitPullRequestBody,
  type PullRequestBodySegment,
} from "@t3tools/client-runtime/pull-request-markdown";
import { markdownTaskMarkerOffset } from "@t3tools/shared/markdownTaskList";
import type { ReactNode } from "react";
import { PixelRatio, View } from "react-native";
import { useProject } from "../../state/entities";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import {
  PullRequestMedia,
  PullRequestMediaContext,
  usePullRequestImageUrl,
} from "./PullRequestMedia";
import { videoMimeType } from "@t3tools/shared/video";
import { createContext, useContext, useMemo, useState } from "react";
import {
  changeRequestReferenceAutolinker,
  resolveChangeRequestMediaUrl,
} from "@t3tools/client-runtime/pull-request-markdown";
import {
  sourceControlClients,
  type ReferenceAutolink,
} from "@t3tools/client-runtime/source-control-clients";
import { linkReferenceAutolinks } from "./pullRequestAutolinks";

import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { markdownImageDimensions } from "../../lib/markdownDocument";
import { markdownImageSources } from "../../lib/markdownImageSources";
import { FilePreviewGallery, useFilePreviewGallery } from "../../components/ui/FilePreviewGallery";
import { pullRequestImageSource, pullRequestMediaSource } from "./pullRequestMediaSource";
import { refreshAssetUrl } from "../../state/assets";
import { pullRequestImageWidth } from "@t3tools/client-runtime/pull-request-image-preview";
import {
  FilePreviewModal,
  type FilePreviewSource,
  type FilePreviewItem,
} from "../../components/ui/FilePreviewModal";
import { ThreadMarkdownImageView } from "../threads/ThreadMarkdownImage";
import type { MarkdownImageRenderer } from "../../native/SelectableMarkdownText";
import type { SelectableMarkdownTextProps } from "../../native/SelectableMarkdownText.types";

const AutolinksContext = createContext<((text: string) => ReadonlyArray<ReferenceAutolink>) | null>(
  null,
);
const LineBreaksContext = createContext(false);
const ChangeRequestUrlContext = createContext<string | null>(null);

export function PullRequestMarkdownRepository(props: {
  /** The change request the markdown belongs to, whose host decides what its text links. */
  readonly changeRequest: { readonly provider: string; readonly url: string } | null | undefined;
  readonly params: PullRequestParams;
  readonly children: ReactNode;
}) {
  const provider = props.changeRequest?.provider;
  const url = props.changeRequest?.url;
  const autolinks =
    provider === undefined || url === undefined
      ? null
      : changeRequestReferenceAutolinker({ provider, url });
  const lineBreaks = sourceControlClients.find(provider ?? "")?.hardLineBreaks ?? false;
  const target = pullRequestTarget(props.params);
  const project = useProject({
    environmentId: target.environmentId,
    projectId: target.input.projectId,
  });
  const cwd = project?.workspaceRoot;
  const media = cwd
    ? { environmentId: target.environmentId, cwd, repository: target.input.repository }
    : null;
  return (
    <AutolinksContext value={autolinks}>
      <LineBreaksContext value={lineBreaks}>
        <ChangeRequestUrlContext value={url ?? null}>
          <PullRequestMediaContext value={media}>{props.children}</PullRequestMediaContext>
        </ChangeRequestUrlContext>
      </LineBreaksContext>
    </AutolinksContext>
  );
}

function MarkdownImage(props: {
  readonly href: string;
  readonly alt: string | null;
  readonly onPreview: (source: FilePreviewSource) => void;
  readonly enabled: boolean;
  readonly knownSize: { width: number; height?: number } | undefined;
}) {
  const media = usePullRequestImageUrl(props.href, props.enabled);
  const context = useContext(PullRequestMediaContext);
  const withGallery = useFilePreviewGallery();
  return (
    <ThreadMarkdownImageView
      knownSize={
        props.knownSize?.height
          ? { width: props.knownSize.width, height: props.knownSize.height }
          : undefined
      }
      authoredWidth={props.knownSize?.width}
      reserveFrame={media.reserveFrame}
      sourceDimensions={media.sourceDimensions}
      placeholderUri={media.placeholderUri}
      uri={media.uri}
      sourceKey={props.href}
      cacheKey={media.cacheKey}
      unavailable={media.unavailable || !/^https?:\/\//i.test(props.href)}
      alt={props.alt}
      onViewOriginal={() =>
        props.onPreview({
          ...pullRequestImageSource(props.href, context),
          previewImage: false,
          name: props.alt ?? "Image",
        })
      }
      onPressPreview={(source) =>
        props.onPreview(
          withGallery({
            ...pullRequestImageSource(props.href, context),
            name: source.name,
            sourceIdentifier: source.sourceIdentifier,
          }),
        )
      }
    />
  );
}

export function PullRequestMarkdown(props: {
  readonly markdown: string;
  readonly imageGroupMarkdown?: string;
  readonly lineBreaks?: boolean;
  /**
   * `markerOffset` is into `markdown`. Returning false, or a tap that can't be traced back to
   * the source, undoes the tick the renderer already drew.
   */
  readonly onTaskListChange?: (input: {
    readonly markerOffset: number;
    readonly checked: boolean;
  }) => boolean;
}) {
  const mediaContext = useContext(PullRequestMediaContext);
  const changeRequestUrl = useContext(ChangeRequestUrlContext);
  const segments = useMemo(() => splitPullRequestBody(props.markdown), [props.markdown]);
  const [undoneTicks, setUndoneTicks] = useState(0);
  const gallery: FilePreviewItem[] = markdownImageSources(
    props.imageGroupMarkdown ?? props.markdown,
  )
    .map((href) => (changeRequestUrl ? resolveChangeRequestMediaUrl(href, changeRequestUrl) : href))
    .filter(
      (uri) =>
        /^https?:\/\//i.test(uri) &&
        videoMimeType({ name: uri.split(/[?#]/)[0] ?? uri, mimeType: "" }) === null,
    )
    .map((uri) => pullRequestImageSource(uri, mediaContext));
  const segmentProps = {
    gallery,
    lineBreaks: props.lineBreaks,
    undoneTicks,
    onTaskListChange: props.onTaskListChange,
    onTaskListUndone: () => setUndoneTicks((count) => count + 1),
  };
  return (
    <View style={{ gap: 12 }}>
      {segments.map((segment) => (
        <PullRequestBodySegmentView key={segment.id} segment={segment} {...segmentProps} />
      ))}
    </View>
  );
}

function PullRequestBodySegmentView(props: {
  readonly segment: PullRequestBodySegment;
  readonly gallery: FilePreviewItem[];
  readonly lineBreaks: boolean | undefined;
  readonly undoneTicks: number;
  readonly onTaskListChange:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => boolean)
    | undefined;
  readonly onTaskListUndone: () => void;
}) {
  const { segment, onTaskListChange } = props;
  if (segment.kind === "markdown") {
    return (
      <PullRequestMarkdownContent
        key={props.undoneTicks}
        markdown={segment.text}
        gallery={props.gallery}
        lineBreaks={props.lineBreaks}
        onTaskListItemPress={
          onTaskListChange
            ? (event) => {
                const offset = markdownTaskMarkerOffset(
                  segment.text,
                  event.index,
                  event.text,
                  event.checked,
                );
                const kept =
                  offset !== null &&
                  onTaskListChange({
                    markerOffset: segment.sourceOffset + offset,
                    checked: event.checked,
                  });
                if (!kept) props.onTaskListUndone();
              }
            : undefined
        }
      />
    );
  }
  if (segment.kind === "attachment") {
    return <PullRequestMedia url={segment.url} kind={segment.media} />;
  }
  return (
    <View style={{ gap: 12 }}>
      {segment.rows.map((cells, rowIndex) => (
        // oxlint-disable-next-line react/no-array-index-key -- rows have no identity besides position
        <View key={rowIndex} style={{ flexDirection: "row", gap: 12 }}>
          {cells.map((cell, cellIndex) => (
            // oxlint-disable-next-line react/no-array-index-key -- cells have no identity besides position
            <View key={cellIndex} style={{ flex: 1, minWidth: 0, gap: 12 }}>
              {cell.segments.map((cellSegment) => (
                <PullRequestBodySegmentView key={cellSegment.id} {...props} segment={cellSegment} />
              ))}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function PullRequestMarkdownContent(props: {
  readonly markdown: string;
  readonly gallery: FilePreviewItem[];
  readonly lineBreaks: boolean | undefined;
  readonly onTaskListItemPress?: SelectableMarkdownTextProps["onTaskListItemPress"];
}) {
  const dimensions = useMemo(() => markdownImageDimensions(props.markdown, true), [props.markdown]);
  const hostLineBreaks = useContext(LineBreaksContext);
  const autolinks = useContext(AutolinksContext);
  const mediaContext = useContext(PullRequestMediaContext);
  const changeRequestUrl = useContext(ChangeRequestUrlContext);
  const resolveMediaUrl = (href: string) =>
    changeRequestUrl ? resolveChangeRequestMediaUrl(href, changeRequestUrl) : href;
  const markdown = linkReferenceAutolinks(props.markdown, autolinks);
  const openPullRequest = useOpenPullRequest();
  const openLink = (href: string) => {
    void openPullRequest(href);
  };
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const renderImage: MarkdownImageRenderer = (image) => (
    <PullRequestLazyImage key={image.href}>
      {(enabled) => (
        <MarkdownImage
          href={resolveMediaUrl(image.href)}
          alt={image.alt}
          onPreview={setPreview}
          enabled={enabled}
          knownSize={dimensions.get(image.href)}
        />
      )}
    </PullRequestLazyImage>
  );
  const styles = useMarkdownPreviewStyles();
  return (
    <FilePreviewGallery value={props.gallery}>
      <SelectableMarkdownText
        markdown={markdown}
        preserveSoftBreaks={props.lineBreaks ?? hostLineBreaks}
        textStyle={styles.nativeTextStyle}
        onLinkPress={openLink}
        renderImage={renderImage}
        resolveImageSource={async (image) => {
          // React image slots load standalone images once they scroll into view.
          if (image.standalone) return { uri: "" };
          const url = resolveMediaUrl(image.href);
          const source = pullRequestMediaSource(url, mediaContext);
          if (!source.resource) return null;
          const uri = await refreshAssetUrl(
            source.environmentId,
            /\.(?:gif|svg)(?:[?#]|$)/i.test(url)
              ? source.resource
              : // A table image column is at most 300 dp wide.
                {
                  ...source.resource,
                  imagePreview: { width: pullRequestImageWidth(300, PixelRatio.get()) },
                },
            undefined,
            false,
          );
          if (uri === null) throw new Error("Pull request image is unavailable");
          return { uri };
        }}
        onImagePress={(href) =>
          setPreview(pullRequestImageSource(resolveMediaUrl(href), mediaContext))
        }
        onTaskListItemPress={props.onTaskListItemPress}
      />
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </FilePreviewGallery>
  );
}
