import type { RepositoryIdentity } from "@t3tools/contracts";
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
const CACHE_KEY_SEPARATOR = "\0";

export interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  {
    readonly resolve: (cwd: string) => Effect.Effect<RepositoryIdentity | null>;
  }
>()("t3/project/RepositoryIdentityResolver") {}

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

function parseCurrentBranchRemoteName(stdout: string): string | null {
  const current = stdout.split("\n").find((line) => line.startsWith("*\t"));
  const remoteName = current?.slice(2).trim() ?? "";
  return remoteName.length > 0 ? remoteName : null;
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
    let rootPath = cwd;

    // git is a real executable on every platform — no cmd.exe shell mode, which
    // would split paths containing spaces during cmd's re-tokenization.
    const topLevelResult = yield* processRunner
      .run({
        command: "git",
        args: ["-C", cwd, "rev-parse", "--show-toplevel"],
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (topLevelResult._tag === "Some" && topLevelResult.value.code === 0) {
      rootPath = topLevelResult.value.stdout.trim() || cwd;
    }

    const branchRemoteResult = yield* processRunner
      .run({
        command: "git",
        args: [
          "-C",
          rootPath,
          "for-each-ref",
          "--format=%(HEAD)%09%(upstream:remotename)",
          "refs/heads",
        ],
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    const branchRemoteName =
      branchRemoteResult._tag === "Some" && branchRemoteResult.value.code === 0
        ? parseCurrentBranchRemoteName(branchRemoteResult.value.stdout)
        : null;

    return `${rootPath}${CACHE_KEY_SEPARATOR}${branchRemoteName ?? ""}`;
  },
);

const resolveRepositoryIdentityFromCacheKey = Effect.fn(
  "RepositoryIdentityResolver.resolveFromCacheKey",
)(function* (
  cacheKey: string,
): Effect.fn.Return<RepositoryIdentity | null, never, ProcessRunner.ProcessRunner> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const [rootPath = cacheKey, branchRemoteName = ""] = cacheKey.split(CACHE_KEY_SEPARATOR);
  const remoteConfigResult = yield* processRunner
    .run({
      command: "git",
      args: ["-C", rootPath, "config", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"],
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  if (remoteConfigResult._tag === "None" || remoteConfigResult.value.code !== 0) {
    return null;
  }

  const { remotes, ghDefaultRemote } = parseRemoteConfig(remoteConfigResult.value.stdout);
  const remote = pickPrimaryRemote(remotes, [
    branchRemoteName || null,
    ghDefaultRemote?.remoteName ?? null,
    "upstream",
    "origin",
  ]);
  if (!remote) return null;

  const usesBranchRemote = branchRemoteName.length > 0 && remotes.has(branchRemoteName);
  const repositoryPath =
    !usesBranchRemote && remote.remoteName === ghDefaultRemote?.remoteName
      ? (ghDefaultRemote.repositoryPath ?? undefined)
      : undefined;
  return buildRepositoryIdentity({
    ...remote,
    rootPath,
    ...(repositoryPath ? { repositoryPath } : {}),
  });
});

export const make = Effect.fn("RepositoryIdentityResolver.make")(function* (
  options: RepositoryIdentityResolverOptions = {},
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const repositoryIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
    (cacheKey) =>
      resolveRepositoryIdentityFromCacheKey(cacheKey).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ),
    {
      capacity: options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY,
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
  )(function* (cwd) {
    const cacheKey = yield* resolveRepositoryIdentityCacheKey(cwd).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
    );
    return yield* Cache.get(repositoryIdentityCache, cacheKey);
  });

  return RepositoryIdentityResolver.of({ resolve });
});

export const layer = Layer.effect(RepositoryIdentityResolver, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
