import type { RepositoryIdentity } from "@t3tools/contracts";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
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
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  {
    readonly resolve: (cwd: string) => Effect.Effect<RepositoryIdentity | null>;
  }
>()("t3/project/RepositoryIdentityResolver") {}

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/u.exec(line.trim());
    if (match?.[1] && match[2]) {
      remotes.set(match[1], match[2]);
    }
  }
  return remotes;
}

function parseGhDefaultRemoteName(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const match = /^remote\.(.+)\.gh-resolved\s+base$/u.exec(line.trim());
    if (match?.[1]) return match[1];
  }
  return null;
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
  readonly rootPath: string;
}): RepositoryIdentity {
  const canonicalKey = normalizeGitRemoteUrl(input.remoteUrl);
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
    let cacheKey = cwd;

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
      return cacheKey;
    }

    const candidate = topLevelResult.value.stdout.trim();
    if (candidate.length > 0) {
      cacheKey = candidate;
    }

    return cacheKey;
  },
);

const resolveRepositoryIdentityFromCacheKey = Effect.fn(
  "RepositoryIdentityResolver.resolveFromCacheKey",
)(function* (
  cacheKey: string,
): Effect.fn.Return<RepositoryIdentity | null, never, ProcessRunner.ProcessRunner> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const [remoteResult, ghDefaultResult, branchRemoteResult] = yield* Effect.all(
    [
      processRunner
        .run({
          command: "git",
          args: ["-C", cacheKey, "remote", "-v"],
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.option),
      processRunner
        .run({
          command: "git",
          args: ["-C", cacheKey, "config", "--get-regexp", "^remote\\..*\\.gh-resolved$"],
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.option),
      processRunner
        .run({
          command: "git",
          args: [
            "-C",
            cacheKey,
            "for-each-ref",
            "--format=%(HEAD)%09%(upstream:remotename)",
            "refs/heads",
          ],
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.option),
    ],
    { concurrency: "unbounded" },
  );
  if (remoteResult._tag === "None" || remoteResult.value.code !== 0) {
    return null;
  }

  const ghDefaultRemoteName =
    ghDefaultResult._tag === "Some" && ghDefaultResult.value.code === 0
      ? parseGhDefaultRemoteName(ghDefaultResult.value.stdout)
      : null;
  const branchRemoteName =
    branchRemoteResult._tag === "Some" && branchRemoteResult.value.code === 0
      ? parseCurrentBranchRemoteName(branchRemoteResult.value.stdout)
      : null;
  const remote = pickPrimaryRemote(parseRemoteFetchUrls(remoteResult.value.stdout), [
    ghDefaultRemoteName,
    branchRemoteName,
    "upstream",
    "origin",
  ]);
  return remote ? buildRepositoryIdentity({ ...remote, rootPath: cacheKey }) : null;
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
