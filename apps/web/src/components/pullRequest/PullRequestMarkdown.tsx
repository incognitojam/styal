import { ExternalLinkIcon, PaperclipIcon } from "lucide-react";
import { markdownImageSourceFragment } from "@t3tools/client-runtime/markdown-images";
import { githubMediaFetchUrl } from "@t3tools/shared/githubMedia";
import type {
  AssetResource,
  EnvironmentId,
  PullRequestDetailView,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { createContext, useCallback, useContext, useMemo } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { PULL_REQUESTS_PANEL_REF } from "~/rightPanelStore";

import ChatMarkdown from "../ChatMarkdown";
import type { GithubReferenceSurface } from "../chat/githubReferenceLinks";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import {
  pullRequestRelativeImagePath,
  remarkPullRequestAutolinks,
  splitPullRequestBody,
} from "./pullRequestMarkdown.logic";

export const PullRequestMarkdownContext = createContext<{
  repositoryUrl: string | null;
  threadRef: ScopedThreadRef | null;
} | null>(null);

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
  const cwd = detail.workspaceRoot;
  // A relative image names a file at the pull request head, not in the local checkout.
  const imageAssetResource = useCallback(
    (src: string): Extract<AssetResource, { _tag: "pull-request-file" }> | null => {
      const path = pullRequestRelativeImagePath(src, detail.provider);
      return path === null
        ? null
        : {
            _tag: "pull-request-file",
            projectId: detail.projectId,
            repository: detail.repository,
            number: detail.number,
            path,
          };
    },
    [detail.number, detail.projectId, detail.provider, detail.repository],
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
              cwd={cwd}
              threadRef={resolvedThreadRef}
              pullRequestPanelRef={resolvedThreadRef ?? PULL_REQUESTS_PANEL_REF}
              environmentId={environmentId}
              imageAssetResource={imageAssetResource}
              referenceContext={referenceContext}
              extraRemarkPlugins={extraRemarkPlugins}
              githubMedia
            />
          );
        }
        const githubMediaUrl = segment.media === "video" ? githubMediaFetchUrl(segment.url) : null;
        if (githubMediaUrl !== null) {
          return (
            <PullRequestGitHubVideo
              key={`${segment.id}:${segment.url}`}
              environmentId={environmentId}
              cwd={cwd}
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
  );
}
