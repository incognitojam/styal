import { ExternalLinkIcon, PaperclipIcon } from "lucide-react";
import { markdownImageSourceFragment } from "@t3tools/client-runtime/markdown-images";
import {
  sourceControlClients,
  type ReferenceAutolink,
} from "@t3tools/client-runtime/source-control-clients";
import {
  SOURCE_CONTROL_MEDIA_ASSET,
  type AssetResource,
  type EnvironmentId,
  type PullRequestDetailView,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { createContext, useContext } from "react";
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
  autolinks: ((text: string) => ReadonlyArray<ReferenceAutolink>) | null;
  threadRef: ScopedThreadRef | null;
} | null>(null);

function PullRequestHostVideo({
  environmentId,
  cwd,
  url,
  fetchUrl,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  url: string;
  fetchUrl: string;
}) {
  const resource: AssetResource = { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd, url: fetchUrl };
  const assetUrl = useAssetUrlState(environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(environmentId, resource);
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
  threadRef?: ScopedThreadRef | null;
  className?: string;
}) {
  const cwd = detail.workspaceRoot;
  // A relative image names a file at the pull request head, not in the local checkout.
  const imageAssetResource = (
    src: string,
  ): Extract<AssetResource, { _tag: "pull-request-file" }> | null => {
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
  };
  // The host comes from the change request's own address, so an Enterprise install is read as
  // itself rather than as github.com.
  const referenceContext = ((): GithubReferenceSurface | undefined => {
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
  })();

  const segments = splitPullRequestBody(text);
  const context = useContext(PullRequestMarkdownContext);
  const autolinks = context?.autolinks;
  const resolvedThreadRef = threadRef ?? context?.threadRef ?? undefined;
  const extraRemarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = autolinks
    ? [[remarkPullRequestAutolinks, { autolinks }]]
    : [];
  return (
    <div
      className={cn(
        "space-y-3 [&_[data-markdown-details]]:border-0 [&_[data-markdown-details-summary]]:text-foreground/80 [&_[data-markdown-details-summary]>svg]:text-muted-foreground/60",
        className,
      )}
      data-image-gallery
    >
      {segments.map((segment) => {
        if (segment.kind === "markdown" || segment.media === "image") {
          return (
            <ChatMarkdown
              key={segment.id}
              text={segment.kind === "markdown" ? segment.text : `![](<${segment.url}>)`}
              cwd={cwd}
              threadRef={resolvedThreadRef}
              pullRequestPanelRef={resolvedThreadRef ?? PULL_REQUESTS_PANEL_REF}
              environmentId={environmentId}
              imageAssetResource={imageAssetResource}
              referenceContext={referenceContext}
              extraRemarkPlugins={extraRemarkPlugins}
              sourceControlMedia
            />
          );
        }
        const hostMedia = sourceControlClients.mediaUrl(segment.url);
        if (segment.media === "video" && hostMedia !== null) {
          return (
            <PullRequestHostVideo
              key={`${segment.id}:${segment.url}`}
              environmentId={environmentId}
              cwd={cwd}
              url={segment.url}
              fetchUrl={hostMedia.fetchUrl}
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
          // Desktop converts blocked _blank navigation to openExternal.
          <a
            key={segment.id}
            href={segment.url}
            rel="noreferrer noopener"
            target="_blank"
            className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm hover:bg-muted/60"
          >
            <PaperclipIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              Open attachment on {hostMedia?.definition.label ?? new URL(segment.url).hostname}
            </span>
            <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          </a>
        );
      })}
    </div>
  );
}
