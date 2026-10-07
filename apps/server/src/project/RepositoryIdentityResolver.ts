import type { RepositoryIdentity, SourceControlProviderError } from "@t3tools/contracts";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
  parseGitRemoteConfig,
} from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(1);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);

export interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
  readonly refine?: (
    identity: RepositoryIdentity,
  ) => Effect.Effect<RepositoryIdentity, SourceControlProviderError>;
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  {
    readonly resolve: (
      cwd: string,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<RepositoryIdentity | null>;
  }
>()("@styal/cli/project/RepositoryIdentityResolver") {}

function parseRemoteConfig(stdout: string): {
  readonly remotes: ReadonlyMap<string, string>;
  readonly ghDefaultRemote: {
    readonly remoteName: string;
    readonly repositoryPath: string | null;
  } | null;
} {
  const entries = parseGitRemoteConfig(stdout);
  const remotes = new Map<string, string>();
  for (const entry of entries) {
    if (entry.url) remotes.set(entry.remoteName, entry.url);
  }

  const pinned = entries.find((entry) => entry.ghResolved !== null);
  const ghDefaultRemote = pinned?.ghResolved
    ? {
        remoteName: pinned.remoteName,
        repositoryPath: pinned.ghResolved === "base" ? null : pinned.ghResolved.toLowerCase(),
      }
    : null;

  return { remotes, ghDefaultRemote };
}

function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
  preferredRemoteNames: ReadonlyArray<string | null>,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  for (const preferredRemoteName of preferredRemoteNames) {
    if (preferredRemoteName === null) continue;
    const remoteUrl = remotes.get(preferredRemoteName);
    if (remoteUrl) {
      return { remoteName: preferredRemoteName, remoteUrl };
    }
  }

  const [remoteName, remoteUrl] =
    [...remotes.entries()].toSorted(([left], [right]) => left.localeCompare(right))[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly repositoryPath?: string;
  readonly rootPath: string;
}): RepositoryIdentity {
  const remoteCanonicalKey = normalizeGitRemoteUrl(input.remoteUrl);
  const remoteHost = remoteCanonicalKey.split("/")[0] ?? "";
  const canonicalKey =
    input.repositoryPath && remoteHost
      ? `${remoteHost}/${input.repositoryPath}`
      : remoteCanonicalKey;
  const sourceControlProvider = detectSourceControlProviderFromGitRemoteUrl(input.remoteUrl);
  const repositoryPath = canonicalKey.split("/").slice(1).join("/");
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    rootPath: input.rootPath,
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
  };
}

const resolveRepositoryIdentityCacheKey = Effect.fn("RepositoryIdentityResolver.resolveCacheKey")(
  function* (cwd: string) {
    const processRunner = yield* ProcessRunner.ProcessRunner;

    // git is a real executable on every platform — no cmd.exe shell mode, which
    // would split paths containing spaces during cmd's re-tokenization.
    const topLevelResult = yield* processRunner
      .run({
        command: "git",
        args: ["-C", cwd, "rev-parse", "--show-toplevel"],
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (topLevelResult._tag === "None" || topLevelResult.value.code !== 0) {
      return null;
    }

    const candidate = topLevelResult.value.stdout.trim();
    return candidate.length > 0 ? candidate : null;
  },
);

const resolveRepositoryIdentityFromCacheKey = Effect.fn(
  "RepositoryIdentityResolver.resolveFromCacheKey",
)(function* (
  cacheKey: string,
): Effect.fn.Return<RepositoryIdentity | null, never, ProcessRunner.ProcessRunner> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const remoteConfigResult = yield* processRunner
    .run({
      command: "git",
      args: ["-C", cacheKey, "config", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"],
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  if (remoteConfigResult._tag === "None" || remoteConfigResult.value.code !== 0) {
    return null;
  }

  const { remotes, ghDefaultRemote } = parseRemoteConfig(remoteConfigResult.value.stdout);
  // Follow `gh`, so the app and agents running `gh` in the checkout agree: the
  // `gh repo set-default` choice, else upstream, then origin. The remote the
  // current branch tracks does not count.
  const remote = pickPrimaryRemote(remotes, [
    ghDefaultRemote?.remoteName ?? null,
    "upstream",
    "origin",
  ]);
  if (!remote) return null;

  const repositoryPath =
    remote.remoteName === ghDefaultRemote?.remoteName
      ? (ghDefaultRemote.repositoryPath ?? undefined)
      : undefined;
  return buildRepositoryIdentity({
    ...remote,
    rootPath: cacheKey,
    ...(repositoryPath ? { repositoryPath } : {}),
  });
});

export const make = Effect.fn("RepositoryIdentityResolver.make")(function* (
  options: RepositoryIdentityResolverOptions = {},
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const cacheCapacity = options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY;

  const repositoryRootCache = yield* Cache.makeWith<string, string | null>(
    (cwd) =>
      resolveRepositoryIdentityCacheKey(cwd).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ),
    {
      capacity: cacheCapacity,
      timeToLive: Exit.match({
        onSuccess: (value) =>
          value === null ? Duration.zero : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    },
  );

  const repositoryIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
    (cacheKey) =>
      resolveRepositoryIdentityFromCacheKey(cacheKey).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.flatMap((identity) =>
          identity !== null && options.refine
            ? options.refine(identity).pipe(Effect.catch(() => Effect.succeed(identity)))
            : Effect.succeed(identity),
        ),
      ),
    {
      capacity: cacheCapacity,
      timeToLive: Exit.match({
        onSuccess: (value) =>
          value === null
            ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
            : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    },
  );

  const resolve: RepositoryIdentityResolver["Service"]["resolve"] = Effect.fn(
    "RepositoryIdentityResolver.resolve",
  )(function* (cwd, options) {
    if (options?.refresh) yield* Cache.invalidate(repositoryRootCache, cwd);
    const cacheKey = yield* Cache.get(repositoryRootCache, cwd);
    if (cacheKey === null) return null;
    if (options?.refresh) yield* Cache.invalidate(repositoryIdentityCache, cacheKey);
    return yield* Cache.get(repositoryIdentityCache, cacheKey);
  });

  return RepositoryIdentityResolver.of({ resolve });
});

export const layer = Layer.effect(RepositoryIdentityResolver, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
