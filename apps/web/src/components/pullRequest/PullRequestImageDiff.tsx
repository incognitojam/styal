import type { FileDiffMetadata } from "@pierre/diffs";
import { ChevronDownIcon, ChevronRightIcon, ImageIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import type {
  PullRequestImageDiffContents,
  PullRequestImageDiffContentsLoader,
} from "~/lib/diffFileContents";
import { resolveFileDiffPath } from "~/lib/diffRendering";

type LoadState =
  | { readonly kind: "idle" | "loading" }
  | { readonly kind: "loaded"; readonly contents: PullRequestImageDiffContents }
  | { readonly kind: "error"; readonly message: string };

const CHECKERBOARD_STYLE: CSSProperties = {
  backgroundColor: "var(--background)",
  backgroundImage:
    "linear-gradient(45deg, color-mix(in srgb, var(--foreground) 7%, transparent) 25%, transparent 25%), linear-gradient(-45deg, color-mix(in srgb, var(--foreground) 7%, transparent) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--foreground) 7%, transparent) 75%), linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--foreground) 7%, transparent) 75%)",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
  backgroundSize: "16px 16px",
};

function changeLabel(type: FileDiffMetadata["type"]): string {
  switch (type) {
    case "new":
      return "Added";
    case "deleted":
      return "Deleted";
    case "rename-pure":
      return "Renamed";
    default:
      return "Changed";
  }
}

function ImagePanel({ image, label }: { image: string; label: string }) {
  return (
    <figure className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-background/35">
      <figcaption className="border-b border-border/50 px-3 py-2 text-xs font-medium text-foreground/80">
        {label}
      </figcaption>
      <div
        className="flex min-h-40 flex-1 items-center justify-center p-4"
        style={CHECKERBOARD_STYLE}
      >
        <img
          src={image}
          alt={`${label} version`}
          className="block max-h-[60vh] max-w-full select-none"
          draggable={false}
        />
      </div>
    </figure>
  );
}

/** Renders the available image revisions without introducing interaction beyond file expansion. */
export function PullRequestImageComparison({
  oldImage: oldPayload,
  newImage: newPayload,
  singleSideLabel,
}: PullRequestImageDiffContents & { readonly singleSideLabel?: string }) {
  const oldImage = oldPayload;
  const newImage = newPayload;

  if (oldImage === null && newImage === null) {
    return (
      <div className="px-4 pb-6 pt-2 text-center text-xs text-muted-foreground">
        This image has no previewable revision.
      </div>
    );
  }

  if (oldImage === null || newImage === null) {
    const image = oldImage ?? newImage!;
    const label = singleSideLabel ?? (oldImage === null ? "Added" : "Deleted");
    return (
      <div className="p-4">
        <ImagePanel image={image} label={label} />
      </div>
    );
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 p-4 lg:grid-cols-2">
      <ImagePanel image={oldImage} label="Deleted" />
      <ImagePanel image={newImage} label="Added" />
    </div>
  );
}

export interface PullRequestImageDiffProps {
  readonly fileDiff: FileDiffMetadata;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly loadContents: PullRequestImageDiffContentsLoader;
}

/** One host-backed image file inside the pull-request code stream. */
export function PullRequestImageDiff({
  fileDiff,
  collapsed,
  onToggle,
  loadContents,
}: PullRequestImageDiffProps) {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "idle" });
  const mounted = useRef(true);
  const path = resolveFileDiffPath(fileDiff);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (collapsed || loadState.kind !== "idle") return;
    setLoadState({ kind: "loading" });
    void loadContents(fileDiff).then(
      (contents) => {
        if (mounted.current) setLoadState({ kind: "loaded", contents });
      },
      (error: unknown) => {
        if (!mounted.current) return;
        setLoadState({
          kind: "error",
          message: error instanceof Error ? error.message : "The image diff could not be loaded.",
        });
      },
    );
  }, [collapsed, fileDiff, loadContents, loadState.kind]);

  return (
    <section className="border-b border-border/50 bg-[var(--code-background)] font-sans text-foreground">
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Expand image diff for ${path}` : `Collapse image diff for ${path}`}
        className="flex h-10 w-full min-w-0 items-center gap-2 overflow-hidden px-3 text-left text-xs outline-none transition-colors hover:bg-foreground/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onToggle}
      >
        {collapsed ? (
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <ImageIcon className="size-3.5 shrink-0 text-sky-500" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate leading-5" title={path}>
          {path}
        </span>
        <span className="hidden shrink-0 text-[10px] font-medium leading-5 text-muted-foreground sm:inline">
          {changeLabel(fileDiff.type)} image
        </span>
      </button>

      {!collapsed ? (
        <div
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {loadState.kind === "loaded" ? (
            <PullRequestImageComparison
              {...loadState.contents}
              {...(fileDiff.type === "rename-pure" ? { singleSideLabel: "Current" } : {})}
            />
          ) : loadState.kind === "error" ? (
            <div className="flex min-h-36 flex-col items-center justify-center gap-2 px-4 pb-6 pt-2 text-center text-xs text-muted-foreground">
              <TriangleAlertIcon className="size-4" aria-hidden="true" />
              <p className="max-w-md">{loadState.message}</p>
              <Button size="xs" variant="outline" onClick={() => setLoadState({ kind: "idle" })}>
                Retry
              </Button>
            </div>
          ) : (
            <div className="flex min-h-36 items-center justify-center gap-2 px-4 pb-6 pt-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5 motion-reduce:animate-none" />
              Loading image diff…
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
