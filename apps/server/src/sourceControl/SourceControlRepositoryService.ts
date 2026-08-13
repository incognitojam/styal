import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  SourceControlProviderError,
  SourceControlRepositoryError,
  type SourceControlCloneDefaultRepository,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlCloneProtocol,
  type SourceControlDefaultRepositoryRemote,
  type SourceControlDefaultRepositoryState,
  type SourceControlGetDefaultRepositoryInput,
  type SourceControlProviderKind,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryInfo,
  type SourceControlGetIssueInput,
  type SourceControlIssue,
  type SourceControlListIssuesInput,
  type SourceControlListIssuesResult,
  type SourceControlRepositoryLookupInput,
  type SourceControlSetDefaultRepositoryInput,
} from "@t3tools/contracts";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  parseGitRemoteConfig,
} from "@t3tools/shared/git";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  {
    readonly lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Effect.Effect<SourceControlRepositoryInfo, SourceControlRepositoryError>;
    readonly cloneRepository: (
      input: SourceControlCloneRepositoryInput,
    ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
    readonly publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Effect.Effect<SourceControlPublishRepositoryResult, SourceControlRepositoryError>;
    /**
     * Reads the candidates and current pick for the repository `gh` treats as
     * this checkout's default. Both of these read and write the same git config
     * `gh repo set-default` uses, so the two stay interchangeable.
     */
    readonly getDefaultRepository: (
      input: SourceControlGetDefaultRepositoryInput,
    ) => Effect.Effect<SourceControlDefaultRepositoryState, SourceControlRepositoryError>;
    readonly setDefaultRepository: (
      input: SourceControlSetDefaultRepositoryInput,
    ) => Effect.Effect<SourceControlDefaultRepositoryState, SourceControlRepositoryError>;
    /**
     * Issue browsing resolves the provider from the working directory's remote
     * rather than an explicit `provider` field, so it keeps the richer
     * `SourceControlProviderError` (which carries the CLI install/auth detail
     * the picker's empty state renders).
     */
    readonly listIssues: (
      input: SourceControlListIssuesInput,
    ) => Effect.Effect<SourceControlListIssuesResult, SourceControlProviderError>;
    readonly getIssue: (
      input: SourceControlGetIssueInput,
    ) => Effect.Effect<SourceControlIssue, SourceControlProviderError>;
  }
>()("t3/sourceControl/SourceControlRepositoryService") {}

function mapRepositoryError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) =>
    isSourceControlRepositoryError(cause)
      ? cause
      : new SourceControlRepositoryError({
          operation,
          provider,
          detail: "The source control operation could not be completed.",
          cause,
        }),
  );
}

function toRepositoryInfo(
  provider: SourceControlProviderKind,
  urls: SourceControlRepositoryCloneUrls,
): SourceControlRepositoryInfo {
  return {
    provider,
    nameWithOwner: urls.nameWithOwner,
    url: urls.url,
    sshUrl: urls.sshUrl,
    ...(urls.parentNameWithOwner ? { parentNameWithOwner: urls.parentNameWithOwner } : {}),
  };
}

function selectRemoteUrl(
  urls: SourceControlRepositoryCloneUrls,
  protocol: SourceControlCloneProtocol | undefined,
): string {
  switch (protocol ?? "auto") {
    case "https":
      return urls.url;
    case "ssh":
    case "auto":
      return urls.sshUrl;
  }
}

/**
 * `gh` records the default repository as `remote.<name>.gh-resolved`, which is
 * also what `RepositoryIdentityResolver` reads when it decides which remote
 * identifies a project. One `git config` read covers both the remote list and
 * the current pick.
 */
const GH_RESOLVED_CONFIG_PATTERN = "^remote\\..*\\.(url|gh-resolved)$";

interface ParsedRemoteConfig {
  readonly state: SourceControlDefaultRepositoryState;
  /** Every remote carrying a pin, so a stale second pin gets cleared too. */
  readonly pinnedRemoteNames: ReadonlyArray<string>;
}

/**
 * A remote URL names its repository, but only GitHub's `github.com` shape is
 * parsed with case intact; every other host falls back to the normalized
 * `host/owner/repo` key so Enterprise remotes still read as a repository rather
 * than a URL.
 */
function repositoryNameWithOwnerFromRemoteUrl(url: string): string | null {
  const gitHubNameWithOwner = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url);
  if (gitHubNameWithOwner) {
    return gitHubNameWithOwner;
  }
  const segments = normalizeGitRemoteUrl(url).split("/");
  return segments.length > 1 ? segments.slice(1).join("/") : null;
}

function parseRemoteConfig(stdout: string): ParsedRemoteConfig {
  const entries = parseGitRemoteConfig(stdout);
  const remotes: ReadonlyArray<SourceControlDefaultRepositoryRemote> = entries.flatMap((entry) =>
    entry.url === null
      ? []
      : [
          {
            remoteName: entry.remoteName,
            url: entry.url,
            nameWithOwner: repositoryNameWithOwnerFromRemoteUrl(entry.url),
            provider: detectSourceControlProviderFromGitRemoteUrl(entry.url)?.kind ?? "unknown",
          },
        ],
  );

  const pinnedRemoteNames = entries
    .filter((entry) => entry.ghResolved !== null)
    .map((entry) => entry.remoteName);
  const pinned = entries.find(
    (entry) => entry.ghResolved !== null && remotes.some((r) => r.remoteName === entry.remoteName),
  );

  // `base` means the pinned remote's own repository; anything else names a
  // different one that `gh` reaches through that remote.
  const defaultRepositoryPath =
    pinned && pinned.ghResolved !== "base" ? pinned.ghResolved : undefined;

  return {
    state: {
      remotes,
      defaultRemoteName: pinned?.remoteName ?? null,
      ...(defaultRepositoryPath ? { defaultRepositoryPath } : {}),
    },
    pinnedRemoteNames,
  };
}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), input.slice(2));
  }
  return input;
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const ensureConcreteProvider = (input: {
    readonly operation: string;
    readonly provider: SourceControlProviderKind;
  }) => {
    if (input.provider !== "unknown") {
      return Effect.succeed(input.provider);
    }

    return Effect.fail(
      new SourceControlRepositoryError({
        operation: input.operation,
        provider: input.provider,
        detail: "Choose a source control provider before continuing.",
      }),
    );
  };

  const lookupRepository = Effect.fn("SourceControlRepositoryService.lookupRepository")(function* (
    input: SourceControlRepositoryLookupInput,
  ) {
    const providerKind = yield* ensureConcreteProvider({
      operation: "lookupRepository",
      provider: input.provider,
    });
    const provider = yield* providers.get(providerKind);
    const urls = yield* provider.getRepositoryCloneUrls({
      cwd: input.cwd ?? config.cwd,
      repository: input.repository.trim(),
    });
    return toRepositoryInfo(providerKind, urls);
  });

  const normalizeDestinationPath = Effect.fn("SourceControlRepositoryService.normalizeDestination")(
    function* (destinationPath: string) {
      const trimmed = destinationPath.trim();
      if (trimmed.length === 0) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: "unknown",
          detail: "Choose a destination path before cloning.",
        });
      }

      return path.resolve(expandHomePath(trimmed, path));
    },
  );

  const prepareDestination = Effect.fn("SourceControlRepositoryService.prepareDestination")(
    function* (destinationPath: string) {
      const normalizedDestination = yield* normalizeDestinationPath(destinationPath);
      if (yield* fileSystem.exists(normalizedDestination)) {
        const entries = yield* fileSystem
          .readDirectory(normalizedDestination, { recursive: false })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: "unknown",
                  detail: "Destination path already exists and is not a directory.",
                  cause,
                }),
            ),
          );
        if (entries.length > 0) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: "unknown",
            detail: "Destination path already exists and is not empty.",
          });
        }
      } else {
        yield* fileSystem.makeDirectory(path.dirname(normalizedDestination), { recursive: true });
      }

      return {
        destinationPath: normalizedDestination,
        parentPath: path.dirname(normalizedDestination),
        directoryName: path.basename(normalizedDestination),
      };
    },
  );

  const readRemoteConfig = Effect.fn("SourceControlRepositoryService.readRemoteConfig")(function* (
    cwd: string,
  ) {
    const result = yield* git.execute({
      operation: "SourceControlRepositoryService.getDefaultRepository",
      cwd,
      args: ["config", "--get-regexp", GH_RESOLVED_CONFIG_PATTERN],
      // Exits non-zero when nothing matches, which just means no remotes.
      allowNonZeroExit: true,
    });
    return parseRemoteConfig(result.stdout);
  });

  const getDefaultRepository = Effect.fn("SourceControlRepositoryService.getDefaultRepository")(
    function* (input: SourceControlGetDefaultRepositoryInput) {
      return (yield* readRemoteConfig(input.cwd)).state;
    },
  );

  /** `gh` keeps exactly one pin, so clear any others before writing the pick. */
  const pinDefaultRemote = Effect.fn("SourceControlRepositoryService.pinDefaultRemote")(
    function* (input: {
      readonly cwd: string;
      readonly remoteName: string | null;
      readonly pinnedRemoteNames: ReadonlyArray<string>;
    }) {
      for (const pinnedRemoteName of input.pinnedRemoteNames) {
        if (pinnedRemoteName === input.remoteName) continue;
        yield* git.execute({
          operation: "SourceControlRepositoryService.setDefaultRepository.unset",
          cwd: input.cwd,
          args: ["config", "--unset-all", `remote.${pinnedRemoteName}.gh-resolved`],
          // Exits non-zero when the pin vanished between read and write.
          allowNonZeroExit: true,
        });
      }

      if (input.remoteName) {
        yield* git.execute({
          operation: "SourceControlRepositoryService.setDefaultRepository.set",
          cwd: input.cwd,
          // `--replace-all`: `gh` adds resolutions rather than setting them, so
          // the key can already hold several values, and a plain write refuses
          // to overwrite those.
          args: ["config", "--replace-all", `remote.${input.remoteName}.gh-resolved`, "base"],
        });
      }
    },
  );

  const setDefaultRepository = Effect.fn("SourceControlRepositoryService.setDefaultRepository")(
    function* (input: SourceControlSetDefaultRepositoryInput) {
      const config = yield* readRemoteConfig(input.cwd);
      const remoteName = input.remoteName?.trim() || null;
      if (remoteName && !config.state.remotes.some((remote) => remote.remoteName === remoteName)) {
        return yield* new SourceControlRepositoryError({
          operation: "setDefaultRepository",
          provider: "unknown",
          detail: "Choose a remote that exists in this repository.",
        });
      }

      yield* pinDefaultRemote({
        cwd: input.cwd,
        remoteName,
        pinnedRemoteNames: config.pinnedRemoteNames,
      });
      return yield* getDefaultRepository({ cwd: input.cwd });
    },
  );

  /**
   * Wires a freshly cloned fork to the repository it was forked from. The
   * `upstream` remote is the easy half; pinning the default repository is the
   * half that keeps the clone honest. `gh` picks a fork's parent as its base
   * repository whenever several remotes exist, so adding `upstream` without a
   * pin would silently retarget `gh pr create` and `gh issue list` at the
   * parent project, whichever repository the user actually meant.
   */
  const wireForkUpstream = Effect.fn("SourceControlRepositoryService.wireForkUpstream")(
    function* (input: {
      readonly cwd: string;
      readonly provider: SourceControlProviderKind;
      readonly parentNameWithOwner: string;
      readonly protocol: SourceControlCloneProtocol | undefined;
      readonly defaultRepository: SourceControlCloneDefaultRepository;
    }) {
      const parent = yield* lookupRepository({
        provider: input.provider,
        repository: input.parentNameWithOwner,
        cwd: input.cwd,
      });
      const remoteUrl = selectRemoteUrl(parent, input.protocol);
      const clonedRemoteName = yield* git.resolvePrimaryRemoteName(input.cwd);
      const remoteName = yield* git.ensureRemote({
        cwd: input.cwd,
        preferredName: "upstream",
        url: remoteUrl,
      });

      // The remotes were just created here, so the pick needs no re-validation;
      // a fresh clone also has nothing pinned to clear.
      yield* pinDefaultRemote({
        cwd: input.cwd,
        remoteName: input.defaultRepository === "parent" ? remoteName : clonedRemoteName,
        pinnedRemoteNames: [],
      });

      // `gh repo clone` leaves a fetched upstream behind, so `upstream/main`
      // resolves immediately. A fork shares history with its parent, so this is
      // usually a small incremental fetch — and the remote is already wired up,
      // so a slow or failing network here must not undo any of the above.
      yield* git.fetchRemote({ cwd: input.cwd, remoteName }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Fetching the fork upstream remote failed", {
            cwd: input.cwd,
            remoteName,
            cause,
          }),
        ),
        Effect.ignore,
      );

      return { remoteName, nameWithOwner: parent.nameWithOwner, remoteUrl };
    },
  );

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
  ) {
    const preparedDestination = yield* prepareDestination(input.destinationPath);
    let repository: SourceControlRepositoryInfo | null = null;
    let remoteUrl = input.remoteUrl?.trim() ?? null;
    let provider: SourceControlProviderKind = input.provider ?? "unknown";

    if (input.provider && input.repository) {
      provider = input.provider;
      repository = yield* lookupRepository({
        provider: input.provider,
        repository: input.repository,
        cwd: preparedDestination.parentPath,
      }).pipe(
        // A clone URL the client already resolved is enough to clone from. A
        // failed lookup then only costs the fork wiring below, not the clone.
        Effect.catch((cause) => (remoteUrl ? Effect.succeed(null) : Effect.fail(cause))),
      );
      if (repository) {
        remoteUrl = selectRemoteUrl(repository, input.protocol);
      }
    }

    if (!remoteUrl) {
      return yield* new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider,
        detail: "Enter a repository path or clone URL before cloning.",
      });
    }

    yield* git.execute({
      operation: "SourceControlRepositoryService.cloneRepository",
      cwd: preparedDestination.parentPath,
      args: ["clone", remoteUrl, preparedDestination.directoryName],
      timeoutMs: 120_000,
      maxOutputBytes: 256 * 1024,
    });

    const parentNameWithOwner = repository?.parentNameWithOwner ?? null;
    const upstream = !parentNameWithOwner
      ? null
      : yield* wireForkUpstream({
          cwd: preparedDestination.destinationPath,
          provider,
          parentNameWithOwner,
          protocol: input.protocol,
          // `gh repo clone` would pick the parent here, but T3 identifies a
          // checkout by the remote its branch tracks: pinning the fork keeps
          // the two agreeing for work on the fork, and choosing the parent
          // stays one keystroke away for contributing upstream.
          defaultRepository: input.defaultRepository ?? "cloned",
        }).pipe(
          // The clone is already on disk and usable; a fork whose parent could
          // not be wired up is a warning, not a failed clone.
          Effect.tapError((cause) =>
            Effect.logWarning("Fork upstream wiring failed after clone", {
              cwd: preparedDestination.destinationPath,
              parent: parentNameWithOwner,
              cause,
            }),
          ),
          Effect.orElseSucceed(() => null),
        );

    return {
      cwd: preparedDestination.destinationPath,
      remoteUrl,
      repository,
      ...(upstream ? { upstream } : {}),
    };
  });

  const publishRepository = Effect.fn("SourceControlRepositoryService.publishRepository")(
    function* (input: SourceControlPublishRepositoryInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "publishRepository",
        provider: input.provider,
      });
      const provider = yield* providers.get(providerKind);
      const urls = yield* provider.createRepository({
        cwd: input.cwd,
        repository: input.repository.trim(),
        visibility: input.visibility,
      });
      const remoteUrl = selectRemoteUrl(urls, input.protocol);
      const remoteName = yield* git.ensureRemote({
        cwd: input.cwd,
        preferredName: input.remoteName?.trim() || "origin",
        url: remoteUrl,
      });

      // An empty local repo (no commits) would make `git push HEAD:...` fail
      // with an opaque "src refspec HEAD does not match any". Treat this as a
      // partial success: the remote was created and wired up, but there is
      // nothing to push yet.
      const hasCommits = yield* git
        .execute({
          operation: "SourceControlRepositoryService.publishRepository.headCheck",
          cwd: input.cwd,
          args: ["rev-parse", "--verify", "HEAD"],
        })
        .pipe(
          Effect.map(() => true),
          Effect.orElseSucceed(() => false),
        );
      if (!hasCommits) {
        const details = yield* git.statusDetails(input.cwd).pipe(Effect.orElseSucceed(() => null));
        return {
          repository: toRepositoryInfo(providerKind, urls),
          remoteName,
          remoteUrl,
          branch: details?.branch ?? "main",
          status: "remote_added" as const,
        };
      }

      const pushResult = yield* git.pushCurrentBranch(input.cwd, null, { remoteName });

      return {
        repository: toRepositoryInfo(providerKind, urls),
        remoteName,
        remoteUrl,
        branch: pushResult.branch,
        ...(pushResult.upstreamBranch ? { upstreamBranch: pushResult.upstreamBranch } : {}),
        status: "pushed" as const,
      };
    },
  );

  const listIssues = Effect.fn("SourceControlRepositoryService.listIssues")(function* (
    input: SourceControlListIssuesInput,
  ) {
    const provider = yield* providers.resolve({ cwd: input.cwd });
    const issues = yield* provider.listIssues({
      cwd: input.cwd,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    return { provider: provider.kind, issues } satisfies SourceControlListIssuesResult;
  });

  const getIssue = Effect.fn("SourceControlRepositoryService.getIssue")(function* (
    input: SourceControlGetIssueInput,
  ) {
    const provider = yield* providers.resolve({ cwd: input.cwd });
    return yield* provider.getIssue({ cwd: input.cwd, number: input.number });
  });

  return SourceControlRepositoryService.of({
    listIssues,
    getIssue,
    lookupRepository: (input) =>
      lookupRepository(input).pipe(mapRepositoryError("lookupRepository", input.provider)),
    cloneRepository: (input) =>
      cloneRepository(input).pipe(
        mapRepositoryError("cloneRepository", input.provider ?? "unknown"),
      ),
    publishRepository: (input) =>
      publishRepository(input).pipe(mapRepositoryError("publishRepository", input.provider)),
    getDefaultRepository: (input) =>
      getDefaultRepository(input).pipe(mapRepositoryError("getDefaultRepository", "unknown")),
    setDefaultRepository: (input) =>
      setDefaultRepository(input).pipe(mapRepositoryError("setDefaultRepository", "unknown")),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);
