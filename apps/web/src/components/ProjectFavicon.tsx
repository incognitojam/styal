import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  getProjectFaviconResourceKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import { FolderCodeIcon } from "lucide-react";
import type { IconName } from "lucide-react/dynamic";
import type { ComponentType } from "react";
import { lazy, Suspense, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useAssetUrlState } from "../assets/assetUrls";
import { projectFaviconUrlAtom } from "../state/assets";
import { deriveProjectIdentity } from "../projectIdentity";
import { projectIconColorClassName } from "../projectIconColors";
import { cn } from "~/lib/utils";

const NO_PROJECT_FAVICON_URL = Atom.make<string | null>(null);
const DynamicIcon = lazy(() =>
  import("lucide-react/dynamic").then((module) => ({ default: module.DynamicIcon })),
);

function DynamicProjectIconFallback() {
  return <FolderCodeIcon className="size-full text-[inherit]" />;
}

// The slice of a project that decides its icon. Every surface must pass the
// project record itself (or a snapshot spread from it) so the saved title, favicon
// and icon override always travel together. Passing a display label as the title
// changes the automatic icon, which is how the command palette drifted once.
export type ProjectFaviconProject = Pick<
  EnvironmentProject,
  "environmentId" | "workspaceRoot" | "title" | "faviconPath" | "projectIcon"
>;

type ProjectFaviconInput = {
  className?: string | undefined;
  fallbackIcon?: ComponentType<{ className?: string }>;
} & (
  | { readonly project: ProjectFaviconProject; readonly legacyProjectId?: undefined }
  | {
      readonly project?: undefined;
      readonly environmentId: EnvironmentId;
      readonly legacyProjectId: string;
    }
);

export function ProjectFavicon(input: ProjectFaviconInput) {
  const { project } = input;
  // Import previews name a project that is not in any environment yet, so its icon comes from the
  // legacy data directory rather than the cached project favicon.
  const cachedSrc = useAtomValue(
    project === undefined
      ? NO_PROJECT_FAVICON_URL
      : projectFaviconUrlAtom({
          environmentId: project.environmentId,
          cwd: project.workspaceRoot,
          faviconPath: project.faviconPath,
        }),
  );
  const legacyAsset = useAssetUrlState(
    input.project === undefined ? input.environmentId : input.project.environmentId,
    input.project === undefined
      ? { _tag: "legacy-project-favicon", projectId: input.legacyProjectId }
      : null,
  );
  const src =
    project === undefined ? (legacyAsset._tag === "Success" ? legacyAsset.url : null) : cachedSrc;
  if (project?.projectIcon?.kind === "emoji") {
    return (
      <ProjectFaviconFallback
        className={input.className}
        icon={FolderCodeIcon}
        emoji={project.projectIcon.emoji}
      />
    );
  }
  if (project?.projectIcon?.kind === "lucide") {
    const colorClassName = projectIconColorClassName(project.projectIcon.color);
    const iconClassName = cn(
      "inline-flex size-3.5 shrink-0 items-center justify-center",
      colorClassName,
      input.className,
    );
    return (
      <span aria-hidden="true" className={iconClassName}>
        <Suspense fallback={<DynamicProjectIconFallback />}>
          <DynamicIcon
            name={project.projectIcon.name as IconName}
            className={cn("size-full", colorClassName)}
            fallback={DynamicProjectIconFallback}
          />
        </Suspense>
      </span>
    );
  }
  const FallbackIcon = input.fallbackIcon ?? FolderCodeIcon;

  if (!src || isProjectFaviconFallbackUrl(src)) {
    return (
      <ProjectFaviconFallback
        className={input.className}
        icon={FallbackIcon}
        projectName={project?.title}
      />
    );
  }

  const cacheKey =
    input.project === undefined
      ? getProjectFaviconResourceKey(input.environmentId, `legacy:${input.legacyProjectId}`, null)
      : getProjectFaviconResourceKey(
          input.project.environmentId,
          input.project.workspaceRoot,
          input.project.faviconPath,
        );

  return (
    <ProjectFaviconImage
      key={cacheKey}
      src={src}
      className={input.className}
      fallbackIcon={FallbackIcon}
      fallbackProjectName={project?.title}
    />
  );
}

function ProjectFaviconFallback({
  className,
  icon: Icon,
  emoji,
  projectName,
}: {
  readonly className?: string | undefined;
  readonly icon: ComponentType<{ className?: string }>;
  readonly emoji?: string | undefined;
  readonly projectName?: string | undefined;
}) {
  if (projectName && projectName.trim().length > 0) {
    const identity = deriveProjectIdentity(projectName);
    // Wrapped like the emoji and Lucide branches so the monogram sits where an
    // <img> favicon would. Menu items, buttons and the like pull every bare svg
    // in with [&_svg]:-mx-0.5 to trim the padding stroke icons carry, and this
    // tile has no such padding.
    return (
      <span
        aria-hidden="true"
        className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
      >
        <svg
          viewBox="0 0 16 16"
          className="size-full overflow-hidden rounded-[25%] font-mono select-none"
          style={{
            backgroundColor: identity.background,
            backgroundImage: `linear-gradient(145deg, ${identity.highlight}, ${identity.background} 72%)`,
          }}
        >
          <text
            x="8"
            y="10.8"
            textAnchor="middle"
            fill="white"
            className="font-mono"
            fontSize="8.25"
            fontWeight="700"
            textLength="12"
            lengthAdjust="spacingAndGlyphs"
            textRendering="geometricPrecision"
          >
            {identity.monogram}
          </text>
          <rect
            x="0.25"
            y="0.25"
            width="15.5"
            height="15.5"
            rx="3.75"
            fill="none"
            strokeWidth="0.5"
            className="stroke-black/10 dark:stroke-white/10"
          />
        </svg>
      </span>
    );
  }

  if (emoji) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex size-3.5 shrink-0 items-center justify-center leading-none [container-type:size]",
          className,
        )}
      >
        <span className="text-[length:80cqh] leading-none">{emoji}</span>
      </span>
    );
  }

  return <Icon className={cn("size-3.5 shrink-0 text-icon-muted", className)} />;
}

function ProjectFaviconImage({
  src,
  className,
  fallbackIcon: FallbackIcon,
  fallbackProjectName,
}: {
  readonly src: string;
  readonly className?: string | undefined;
  readonly fallbackIcon: ComponentType<{ className?: string }>;
  readonly fallbackProjectName?: string | undefined;
}) {
  const [displayedSrc, setDisplayedSrc] = useState<string | null>(() =>
    src.startsWith("data:image/") ? src : null,
  );
  const isLoading = displayedSrc !== src;
  const handleLoadError = (failedSrc: string) => {
    setDisplayedSrc((currentSrc) => (currentSrc === failedSrc ? null : currentSrc));
  };

  return (
    <>
      {displayedSrc === null ? (
        <ProjectFaviconFallback
          className={className}
          icon={FallbackIcon}
          projectName={fallbackProjectName}
        />
      ) : null}
      {displayedSrc ? (
        <img
          src={displayedSrc}
          alt=""
          className={cn("size-3.5 shrink-0 rounded-[37.5%] object-contain", className)}
          onError={() => handleLoadError(displayedSrc)}
        />
      ) : null}
      {isLoading ? (
        <img
          src={src}
          alt=""
          className="hidden"
          onLoad={() => {
            setDisplayedSrc(src);
          }}
          onError={() => handleLoadError(src)}
        />
      ) : null}
    </>
  );
}
