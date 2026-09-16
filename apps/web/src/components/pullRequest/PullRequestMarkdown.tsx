import type {
  AssetResource,
  EnvironmentId,
  PullRequestDetailView,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { ExternalLinkIcon, LoaderCircleIcon, PaperclipIcon } from "lucide-react";
import { markdownImageSourceFragment } from "@t3tools/client-runtime/markdown-images";
import { githubMediaFetchUrl } from "@t3tools/shared/githubMedia";
import {
  type ComponentPropsWithoutRef,
  useCallback,
  useMemo,
  useState,
  createContext,
  useContext,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { ExtraProps, Options as ReactMarkdownOptions } from "react-markdown";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { PULL_REQUESTS_PANEL_REF } from "~/rightPanelStore";

import ChatMarkdown from "../ChatMarkdown";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { markdownImageGallery, markdownImageItems } from "../chat/markdownImageGallery";
import type { GithubReferenceSurface } from "../chat/githubReferenceLinks";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import {
  remarkPullRequestAutolinks,
  resolvePullRequestRepositoryImage,
  splitPullRequestBody,
} from "./pullRequestMarkdown.logic";

const PullRequestImagePreviewContext = createContext<(preview: ExpandedImagePreview) => void>(
  () => {},
);

function PullRequestPreviewImage({
  src,
  alt,
  originalUrl,
  ...props
}: ComponentPropsWithoutRef<"img"> & { src: string; originalUrl?: string }) {
  const showPreview = useContext(PullRequestImagePreviewContext);
  const name = alt?.trim() || "image";
  const expand = (event: MouseEvent<HTMLImageElement> | KeyboardEvent<HTMLImageElement>) => {
    if (event.currentTarget.closest("a")) return;
    event.preventDefault();
    event.stopPropagation();
    const item = markdownImageItems.get(event.currentTarget);
    if (item) showPreview(markdownImageGallery(event.currentTarget, item));
  };
  return (
    <img
      {...props}
      ref={(element) => {
        if (element) {
          markdownImageItems.set(element, {
            src,
            name,
            ...(originalUrl ? { originalUrl } : {}),
            actionsSource: { kind: "image", name, src },
          });
        }
      }}
      src={src}
      alt={alt}
      role="button"
      tabIndex={0}
      aria-label={`Preview ${name}`}
      className={cn("cursor-zoom-in", props.className)}
      onClick={expand}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") expand(event);
      }}
    />
  );
}

function PullRequestRepositoryImage({
  detail,
  environmentId,
  path,
  revision,
  browserFallback,
  alt,
  ...props
}: Omit<ComponentPropsWithoutRef<"img">, "src"> & {
  detail: PullRequestDetailView;
  environmentId: EnvironmentId;
  path: string;
  revision?: string;
  browserFallback?: string;
}) {
  const assetUrl = useAssetUrlState(environmentId, {
    _tag: "pull-request-file",
    projectId: detail.projectId,
    repository: detail.repository,
    number: detail.number,
    path,
    ...(revision === undefined ? {} : { revision }),
  });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [failedBrowserFallback, setFailedBrowserFallback] = useState<string | null>(null);

  if (assetUrl._tag === "Loading") {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        role="status"
      >
        <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" />
        Loading image…
      </span>
    );
  }
  if (assetUrl._tag === "Failure" || failedUrl === assetUrl.url) {
    if (browserFallback !== undefined && failedBrowserFallback !== browserFallback) {
      return (
        <PullRequestPreviewImage
          {...props}
          src={browserFallback}
          alt={alt}
          originalUrl={browserFallback}
          onError={() => setFailedBrowserFallback(browserFallback)}
        />
      );
    }
    return (
      <span className="text-xs text-muted-foreground" role="img" aria-label={alt || path}>
        Image unavailable.
      </span>
    );
  }
  return (
    <PullRequestPreviewImage
      {...props}
      src={assetUrl.url}
      alt={alt}
      onError={() => setFailedUrl(assetUrl.url)}
    />
  );
}

/**
 * A video GitHub hosts for the repository. It plays through a signed asset URL the server
 * fetches with the repository's GitHub credential, which is what a private repository's
 * uploads need; the URL is re-signed on retry, so a stale one recovers without a reload.
 */
function PullRequestGitHubVideo({
  environmentId,
  cwd,
  url,
  fetchUrl,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  /** What the body authored, which is what "Open original" should reach. */
  url: string;
  /** The canonical GitHub media URL: a `blob` link addresses the page, not the bytes. */
  fetchUrl: string;
}) {
  const resource = useMemo<AssetResource>(
    () => ({ _tag: "github-media", cwd, url: fetchUrl }),
    [cwd, fetchUrl],
  );
  const assetUrl = useAssetUrlState(environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(environmentId, resource);
  // A server too old to sign this resource, or one with no route to GitHub, still leaves a
  // public repository's video playing exactly as it did before.
  const src =
    assetUrl._tag === "Success" ? assetUrl.url : assetUrl._tag === "Failure" ? fetchUrl : null;
  return (
    <MediaVideoPlayer
      src={src === null ? null : src + markdownImageSourceFragment(url)}
      originalUrl={url}
      label="Pull request video"
      className="w-full"
      videoClassName="rounded-lg border border-border/60"
      onRetry={refreshAssetUrl}
    />
  );
}

export const PullRequestMarkdownContext = createContext<{
  repositoryUrl: string | null;
  threadRef: ScopedThreadRef | null;
} | null>(null);

/** Renders PR uploads inline, with retry and an original link when video playback fails. */
export function PullRequestMarkdown({
  text,
  detail,
  environmentId,
  threadRef,
  className,
}: {
  text: string;
  detail: PullRequestDetailView;
  environmentId: EnvironmentId;
  /** Thread the body is shown beside, so its links can open in that thread's in-app browser. */
  threadRef?: ScopedThreadRef | null;
  className?: string;
}) {
  const [expandedImage, setExpandedImage] = useState<{
    text: string;
    detailUrl: string;
    preview: ExpandedImagePreview;
  } | null>(null);
  const showPreview = useCallback(
    (preview: ExpandedImagePreview) => setExpandedImage({ text, detailUrl: detail.url, preview }),
    [detail.url, text],
  );
  const imageRenderer = useCallback(
    ({ node: _node, src, ...props }: ComponentPropsWithoutRef<"img"> & ExtraProps) => {
      const image = src
        ? resolvePullRequestRepositoryImage(src, {
            provider: detail.provider,
            repository: detail.repository,
            url: detail.url,
            headBranch: detail.headBranch,
          })
        : null;
      // Other GitHub-hosted media goes to ChatMarkdown, which fetches it with the
      // repository's GitHub credential.
      if (image === null && src && githubMediaFetchUrl(src) !== null) return undefined;
      return image === null ? (
        src ? (
          <PullRequestPreviewImage {...props} src={src} originalUrl={src} />
        ) : (
          <img {...props} />
        )
      ) : (
        <PullRequestRepositoryImage
          {...props}
          detail={detail}
          environmentId={environmentId}
          path={image.path}
          {...(image.revision === undefined ? {} : { revision: image.revision })}
          {...(image.browserFallback === undefined
            ? {}
            : { browserFallback: image.browserFallback })}
        />
      );
    },
    [detail, environmentId],
  );
  // The host comes from the change request's own address, so an Enterprise install is read as
  // itself rather than as github.com.
  const referenceContext = useMemo((): GithubReferenceSurface | undefined => {
    if (detail.provider !== "github") return undefined;
    let host: string;
    try {
      host = new URL(detail.url).hostname.toLowerCase();
    } catch {
      return undefined;
    }
    return {
      host,
      repository: detail.repository,
      environmentId,
      cwd: detail.workspaceRoot,
    };
  }, [detail.provider, detail.repository, detail.url, detail.workspaceRoot, environmentId]);

  const segments = splitPullRequestBody(text);
  const context = useContext(PullRequestMarkdownContext);
  const repositoryUrl = context?.repositoryUrl;
  const resolvedThreadRef = threadRef ?? context?.threadRef ?? undefined;
  const extraRemarkPlugins = useMemo<NonNullable<ReactMarkdownOptions["remarkPlugins"]>>(
    () => (repositoryUrl ? [[remarkPullRequestAutolinks, { repositoryUrl }]] : []),
    [repositoryUrl],
  );
  return (
    <PullRequestImagePreviewContext value={showPreview}>
      <div
        className={cn(
          "space-y-3 [&_[data-markdown-details]]:border-0 [&_[data-markdown-details-summary]]:text-foreground/80 [&_[data-markdown-details-summary]>svg]:text-muted-foreground/60",
          className,
        )}
        data-image-gallery
      >
        {segments.map((segment) => {
          if (segment.kind === "markdown") {
            return (
              <ChatMarkdown
                key={segment.id}
                text={segment.text}
                cwd={detail.workspaceRoot}
                threadRef={resolvedThreadRef}
                pullRequestPanelRef={resolvedThreadRef ?? PULL_REQUESTS_PANEL_REF}
                environmentId={environmentId}
                imageRenderer={imageRenderer}
                referenceContext={referenceContext}
                extraRemarkPlugins={extraRemarkPlugins}
                githubMedia
              />
            );
          }
          const githubMediaUrl =
            segment.media === "video" ? githubMediaFetchUrl(segment.url) : null;
          if (githubMediaUrl !== null) {
            return (
              <PullRequestGitHubVideo
                key={`${segment.id}:${segment.url}`}
                environmentId={environmentId}
                cwd={detail.workspaceRoot}
                url={segment.url}
                fetchUrl={githubMediaUrl}
              />
            );
          }
          if (segment.media === "video") {
            return (
              <MediaVideoPlayer
                key={`${segment.id}:${segment.url}`}
                src={segment.url}
                originalUrl={segment.url}
                label="Pull request video"
                className="w-full"
                videoClassName="rounded-lg border border-border/60"
              />
            );
          }
          return (
            // A plain anchor rather than the page's openExternal button: the desktop window
            // turns a blocked _blank into openExternal itself, and in a browser tab — where
            // there is no shell to call — this is the only one of the two that goes anywhere.
            <a
              key={segment.id}
              href={segment.url}
              rel="noreferrer noopener"
              target="_blank"
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm hover:bg-muted/60"
            >
              <PaperclipIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">Open attachment on GitHub</span>
              <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            </a>
          );
        })}
      </div>
      {expandedImage?.text === text && expandedImage.detailUrl === detail.url ? (
        <ExpandedImageDialog
          preview={expandedImage.preview}
          onClose={() => setExpandedImage(null)}
        />
      ) : null}
    </PullRequestImagePreviewContext>
  );
}
