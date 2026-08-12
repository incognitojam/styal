import type { EnvironmentId, PullRequestDetailView } from "@t3tools/contracts";
import { ExternalLinkIcon, LoaderCircleIcon, PaperclipIcon, PlayIcon } from "lucide-react";
import { type ComponentPropsWithoutRef, useCallback, useState } from "react";
import type { ExtraProps } from "react-markdown";

import { useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";

import ChatMarkdown from "../ChatMarkdown";
import {
  resolvePullRequestRepositoryImagePath,
  splitPullRequestBody,
} from "./pullRequestMarkdown.logic";

function PullRequestRepositoryImage({
  detail,
  environmentId,
  path,
  alt,
  ...props
}: Omit<ComponentPropsWithoutRef<"img">, "src"> & {
  detail: PullRequestDetailView;
  environmentId: EnvironmentId;
  path: string;
}) {
  const assetUrl = useAssetUrlState(environmentId, {
    _tag: "pull-request-file",
    projectId: detail.projectId,
    repository: detail.repository,
    number: detail.number,
    path,
  });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

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
    return (
      <span className="text-xs text-muted-foreground" role="img" aria-label={alt || path}>
        Image unavailable.
      </span>
    );
  }
  return <img {...props} src={assetUrl.url} alt={alt} onError={() => setFailedUrl(assetUrl.url)} />;
}

/**
 * A pull request body, rendered with the app's markdown renderer plus a card for each upload
 * embedded in it, which that renderer drops on the floor.
 *
 * The card links out instead of playing in place, because nothing here can play. A
 * `github.com/user-attachments/assets/…` link is a 302 to a signed S3 URL that serves the file
 * as uploaded — `video/quicktime` for anything recorded on a Mac, which no Chromium decodes —
 * and the desktop window's content policy declares no `media-src`, so media falls back to
 * `default-src 'self'` and every remote source is refused before a byte is fetched. A player
 * here can only be the box that never fills in; a card that opens the host is a real answer.
 */
export function PullRequestMarkdown({
  text,
  detail,
  environmentId,
  className,
}: {
  text: string;
  detail: PullRequestDetailView;
  environmentId: EnvironmentId;
  className?: string;
}) {
  const imageRenderer = useCallback(
    ({ node: _node, src, ...props }: ComponentPropsWithoutRef<"img"> & ExtraProps) => {
      const path = src
        ? resolvePullRequestRepositoryImagePath(src, {
            provider: detail.provider,
            repository: detail.repository,
            url: detail.url,
            headBranch: detail.headBranch,
          })
        : null;
      return path === null ? (
        <img {...props} src={src} />
      ) : (
        <PullRequestRepositoryImage
          {...props}
          detail={detail}
          environmentId={environmentId}
          path={path}
        />
      );
    },
    [detail, environmentId],
  );
  const segments = splitPullRequestBody(text);
  return (
    <div className={cn("space-y-3", className)}>
      {segments.map((segment) => {
        if (segment.kind === "markdown") {
          return (
            <ChatMarkdown
              key={segment.id}
              text={segment.text}
              cwd={detail.workspaceRoot}
              imageRenderer={imageRenderer}
            />
          );
        }
        const isVideo = segment.media === "video";
        const Icon = isVideo ? PlayIcon : PaperclipIcon;
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
            <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              {isVideo ? "Play video on GitHub" : "Open attachment on GitHub"}
            </span>
            <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          </a>
        );
      })}
    </div>
  );
}
