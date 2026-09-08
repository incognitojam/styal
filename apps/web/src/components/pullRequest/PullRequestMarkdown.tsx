import type { EnvironmentId, PullRequestDetailView, ScopedThreadRef } from "@t3tools/contracts";
import { ExternalLinkIcon, LoaderCircleIcon, PaperclipIcon } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  useCallback,
  useMemo,
  useState,
  createContext,
  useContext,
} from "react";
import type { ExtraProps, Options as ReactMarkdownOptions } from "react-markdown";

import { useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { PULL_REQUESTS_PANEL_REF } from "~/rightPanelStore";

import ChatMarkdown from "../ChatMarkdown";
import type { GithubReferenceSurface } from "../chat/githubReferenceLinks";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import {
  remarkPullRequestAutolinks,
  resolvePullRequestRepositoryImage,
  splitPullRequestBody,
} from "./pullRequestMarkdown.logic";

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
        <img
          {...props}
          src={browserFallback}
          alt={alt}
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
  return <img {...props} src={assetUrl.url} alt={alt} onError={() => setFailedUrl(assetUrl.url)} />;
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
      return image === null ? (
        <img {...props} src={src} />
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
    <div className={cn("space-y-3", className)} data-image-gallery>
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
