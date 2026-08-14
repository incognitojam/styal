/**
 * What the `#123` in a rendered body points at, and where following it goes. Resolving only
 * improves a link that already works, and only an answer marks one as broken: a request that
 * failed on the way leaves every reference alone.
 */
import type {
  EnvironmentId,
  ScopedThreadRef,
  SourceControlResolvedReference,
} from "@t3tools/contracts";
import { createContext, useCallback, useMemo } from "react";

import {
  collectGithubReferences,
  formatGithubReferenceKey,
  type GithubReferenceContext,
} from "~/markdown-github-references";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { useEnvironmentQuery } from "~/state/query";

/** The context a body needs to have its references both written and answered. */
export interface GithubReferenceSurface extends GithubReferenceContext {
  readonly environmentId: EnvironmentId;
  /** The checkout the question is asked from, which names the host it is asked of. */
  readonly cwd: string;
  /** The thread this body is read beside, if any: a reference opens as a tab next to it. */
  readonly threadRef?: ScopedThreadRef | undefined;
}

/** The thread a pull request surface is mounted beside, told to the bodies it renders. */
export const GithubReferenceThreadContext = createContext<ScopedThreadRef | undefined>(undefined);

export type GithubReferenceResolution =
  /** No answer: on its way, never asked for, or asked and not given. Nothing is claimed. */
  | { readonly status: "unresolved" }
  /** The host has nothing under this number: deleted, never there, or someone else's. */
  | { readonly status: "missing" }
  | { readonly status: "resolved"; readonly reference: SourceControlResolvedReference };

const UNRESOLVED: GithubReferenceResolution = { status: "unresolved" };

/** Reads what is known about one reference, by the key the anchor carries. */
export type GithubReferenceLookup = (key: string) => GithubReferenceResolution;

export function useGithubReferenceResolutions(
  surface: GithubReferenceSurface | undefined,
  text: string,
): GithubReferenceLookup {
  const host = surface?.host;
  const repository = surface?.repository;
  const references = useMemo(
    () =>
      host === undefined || repository === undefined
        ? []
        : collectGithubReferences({ host, repository }, text),
    [host, repository, text],
  );

  const query = useEnvironmentQuery(
    surface && references.length > 0
      ? sourceControlEnvironment.references({
          environmentId: surface.environmentId,
          input: { cwd: surface.cwd, references },
        })
      : null,
  );

  const answered = query.data;
  const byKey = useMemo(() => {
    const resolutions = new Map<string, GithubReferenceResolution>();
    // A reference is keyed by repository and number, which an Enterprise install and github.com
    // spell identically — so answers from another host are not answers about these references.
    if (answered === null || answered.host.toLowerCase() !== host?.toLowerCase())
      return resolutions;
    for (const reference of answered.references) {
      resolutions.set(
        formatGithubReferenceKey(reference),
        reference.kind === null ? { status: "missing" } : { status: "resolved", reference },
      );
    }
    return resolutions;
  }, [answered, host]);

  return useCallback((key) => byKey.get(key) ?? UNRESOLVED, [byKey]);
}

/**
 * Where to follow a reference: the link as written until the host gives its own address, which is
 * what makes a pull request recognisable as one on the way out.
 */
export function githubReferenceHref(
  resolution: GithubReferenceResolution,
  writtenHref: string,
): string {
  return resolution.status === "resolved" && resolution.reference.url !== null
    ? resolution.reference.url
    : writtenHref;
}

/**
 * A reference the host has nothing under, marked the way an unknown word is, and still a link —
 * the reader may have access in a browser they are signed into differently. An attribute rather
 * than a class, because `.chat-markdown a` sets `text-decoration: none` and outranks one.
 */
export const MISSING_GITHUB_REFERENCE_ATTRIBUTE = "data-github-reference-missing";

export function missingGithubReferenceTitle(
  resolution: GithubReferenceResolution,
  label: string,
): string | undefined {
  return resolution.status === "missing"
    ? `Could not find ${label} — it may be private or deleted.`
    : undefined;
}

interface ReferenceClickEvent {
  preventDefault: () => void;
  stopPropagation: () => void;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

/** Clicked before its answer arrives, a reference follows the link as written: the right page, in
 * a browser. Holding the click to open it as a tab was not worth the pending click. */
export function useGithubReferenceOpener(
  lookup: GithubReferenceLookup,
  openChangeRequestLink: (
    event: ReferenceClickEvent,
    targetUrl: string,
    targetThreadRef?: ScopedThreadRef,
  ) => boolean,
  threadRef: ScopedThreadRef | undefined,
): (event: ReferenceClickEvent, key: string, writtenHref: string) => void {
  return useCallback(
    (event, key, writtenHref) => {
      // A modifier means the browser, which the anchor's own default action already does.
      if (event.metaKey || event.ctrlKey) return;
      openChangeRequestLink(event, githubReferenceHref(lookup(key), writtenHref), threadRef);
    },
    [lookup, openChangeRequestLink, threadRef],
  );
}
