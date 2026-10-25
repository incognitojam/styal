import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  SourceControlProviderError,
  SourceControlRepositoryError,
  type SourceControlCloneDefaultRepository,
  type GitCommandFailureReason,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlCloneProtocol,
  type SourceControlDefaultRepositoryRemote,
  type SourceControlDefaultRepositoryState,
  type SourceControlGetDefaultRepositoryInput,
  SourceControlProviderKind,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryInfo,
  type SourceControlGetIssueInput,
  type SourceControlIssue,
  type SourceControlListIssuesInput,
  type SourceControlListIssuesResult,
  type SourceControlReference,
  type SourceControlResolveReferencesInput,
  type SourceControlResolveReferencesResult,
  type SourceControlRepositoryLookupInput,
  type SourceControlSetDefaultRepositoryInput,
  type SourceControlUpstreamRemote,
} from "@t3tools/contracts";
import { parseGitRemoteConfig } from "@t3tools/shared/git";

import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import {
  parseGitCloneProgressLine,
  type GitCloneProgressLine,
} from "../project/gitCloneProgress.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { classifyNonZeroExit } from "../vcs/VcsProcess.ts";
import { MAX_REFERENCES_PER_REQUEST } from "@t3tools/source-control-github/server/gitHubReferences";
import { makeReferenceCache } from "./referenceCache.ts";
import { sourceControlDefinitions } from "./sourceControlDefinitions.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import { cloneUrlForProtocol, cloneUrlProtocol } from "@t3tools/shared/cloneUrl";
const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);
const isSourceControlProviderError = Schema.is(SourceControlProviderError);
const isGitCommandError = Schema.is(GitCommandError);

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  {
    readonly lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Effect.Effect<SourceControlRepositoryInfo, SourceControlRepositoryError>;
    readonly prepareClone: (
      input: SourceControlCloneRepositoryInput,
    ) => Effect.Effect<SourceControlPreparedClone, SourceControlRepositoryError>;
    readonly cloneRepository: (
      input: SourceControlCloneRepositoryInput,
      options?: SourceControlCloneOptions,
    ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
    /**
     * Adds a cloned fork's parent as a remote and pins the default repository.
     * Never fails; resolves to null for a clone that is not a fork or could not
     * be wired up.
     */
    readonly wireClonedFork: (
      input: SourceControlClonedForkInput,
    ) => Effect.Effect<SourceControlUpstreamRemote | null>;
    readonly discardClone: (
      destinationPath: string,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
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
    /** What the references in a body turn out to be, answered together. */
    readonly resolveReferences: (
      input: SourceControlResolveReferencesInput,
    ) => Effect.Effect<SourceControlResolveReferencesResult, SourceControlProviderError>;
  }
>()("@styal/cli/sourceControl/SourceControlRepositoryService") {}

export interface SourceControlPreparedClone {
  readonly destinationPath: string;
  readonly remoteUrl: string;
  readonly cloneUrl: string;
  readonly repository: SourceControlRepositoryInfo | null;
}

export interface SourceControlClonedForkInput {
  readonly cwd: string;
  readonly provider: SourceControlProviderKind;
  readonly repository: SourceControlRepositoryInfo | null;
  /** The URL git cloned from; its transport decides the parent remote's. */
  readonly cloneUrl: string;
  readonly protocol?: SourceControlCloneProtocol | undefined;
  readonly defaultRepository?: SourceControlCloneDefaultRepository | undefined;
}

export interface SourceControlCloneOptions {
  readonly onProgress?: (line: GitCloneProgressLine) => Effect.Effect<void>;
  /** Overrides the default clone budget; `null` disables the deadline. */
  readonly timeoutMs?: number | null;
}

// Older/mobile synchronous RPCs need deadlines; tracked clones use progress and Cancel instead.
const CLONE_TIMEOUT_MS = 120_000;
const CLONE_ENV = {
  // Force piped progress immediately; refuse credential prompts that would hang without a tty.
  GIT_PROGRESS_DELAY: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
} satisfies NodeJS.ProcessEnv;

const CLONE_AUTHENTICATION_FAILURE =
  "Git authentication failed. Set up Git credentials or SSH keys. For GitHub HTTPS, run gh auth login and gh auth setup-git.";
const CLONE_RATE_LIMIT_FAILURE = "The Git host rate limit was exceeded. Wait and retry the clone.";

/**
 * What a failed clone tells the user. Authentication and rate-limit failures get recovery
 * guidance; other failures keep git's last lines, or the process failure (such as a timeout)
 * when git printed nothing.
 */
function describeCloneFailure(stderrTail: ReadonlyArray<string>, cause: GitCommandError): string {
  if (stderrTail.length === 0) {
    return cause.exitCode === undefined ? cause.detail : "The repository could not be cloned.";
  }
  const failureKind = classifyNonZeroExit("git", stderrTail.join("\n"));
  if (failureKind === "authentication") return CLONE_AUTHENTICATION_FAILURE;
  if (failureKind === "rate-limited") return CLONE_RATE_LIMIT_FAILURE;
  return stderrTail.join(" ");
}

function mapRepositoryError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) =>
    isSourceControlRepositoryError(cause)
      ? cause
      : new SourceControlRepositoryError({
          operation,
          provider,
          detail:
            (isSourceControlProviderError(cause)
              ? SourceControlProvider.userFacingSourceControlDetail(cause.cause)
              : undefined) ?? "The source control operation could not be completed.",
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

// Redact credentials from client clone snapshots; git still receives the original URL.
function redactRemoteUrl(remoteUrl: string): string {
  try {
    const url = new URL(remoteUrl);
    // Clone URLs have no legitimate query; when one is present it is a token.
    if (url.username.length === 0 && url.password.length === 0 && url.search.length === 0) {
      return remoteUrl;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return remoteUrl;
  }
}

// Userinfo can contain @; remove through the last one before the host boundary.
const URL_WITH_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi;

function redactUrlCredentials(text: string): string {
  return text.replace(URL_WITH_USERINFO, "$1");
}

// The remote already exists after push failure; advise fixing access and pushing.
// Use fixed text and provider URLs because git stderr can expose credentials.
function publishPushFailureDetail(input: {
  readonly urls: SourceControlRepositoryCloneUrls;
  readonly remoteName: string;
  readonly usesSsh: boolean;
  readonly reason: GitCommandFailureReason | undefined;
}): string {
  const created = `Created ${input.urls.nameWithOwner} and added it as remote "${input.remoteName}", but the push failed`;
  const switchToHttps = `git remote set-url ${input.remoteName} ${input.urls.url}`;
  switch (input.reason) {
    case "authentication_failed":
      return input.usesSsh
        ? `${created} because SSH authentication was rejected. Add an SSH key to your account, or switch the remote to HTTPS with "${switchToHttps}", then push again.`
        : `${created} because Git could not authenticate. Check your Git credentials, then push again.`;
    case "host_key_unverified":
      return `${created} because the host's SSH key is not trusted yet. Verify it by connecting once with ssh, or switch the remote to HTTPS with "${switchToHttps}", then push again.`;
    default:
      return `${created}. Fix the problem, then push again.`;
  }
}

/**
 * SSH rejection can be retried over HTTPS when the host's credential helper is available.
 * Explicit SSH requests must not fall back; unknown URL shapes must not be guessed.
 */
function httpsFallbackUrl(
  input: SourceControlCloneRepositoryInput,
  prepared: SourceControlPreparedClone,
): string | null {
  if (input.protocol === "ssh" || cloneUrlProtocol(prepared.cloneUrl) !== "ssh") return null;
  if (prepared.repository?.sshUrl === prepared.cloneUrl) return prepared.repository.url;
  return cloneUrlForProtocol(prepared.cloneUrl, "https");
}

const isSshRejection = (error: SourceControlRepositoryError) =>
  isGitCommandError(error.cause) &&
  (error.cause.reason === "authentication_failed" || error.cause.reason === "host_key_unverified");

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

/** Explicit protocol wins; otherwise mirror a client-resolved repository URL. */
function resolveCloneProtocol(
  urls: SourceControlRepositoryCloneUrls,
  remoteUrl: string,
  protocol: SourceControlCloneProtocol | undefined,
): SourceControlCloneProtocol | undefined {
  if (protocol !== undefined && protocol !== "auto") return protocol;
  if (remoteUrl === urls.url) return "https";
  if (remoteUrl === urls.sshUrl) return "ssh";
  return undefined;
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
  const gitHubNameWithOwner =
    /^(?:git@github\.com:|ssh:\/\/(?:git@)?github\.com\/|https:\/\/github\.com\/|git:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i
      .exec(url.trim())?.[1]
      ?.trim();
  if (gitHubNameWithOwner) {
    return gitHubNameWithOwner;
  }
  const segments = sourceControlDefinitions.repositoryKeyFromRemote(url).split("/");
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
            provider:
              sourceControlDefinitions.recognizeRemote(entry.url)?.kind ??
              SourceControlProviderKind.make("unknown"),
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

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
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

  const lookupRepository = Effect.fn("SourceControlRepositoryService.lookupRepository")(
    function* (input: SourceControlRepositoryLookupInput) {
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
    },
    // Someone adding or cloning a repository is waiting, so a background rate-limit pause must not
    // refuse the lookup.
    Effect.provideService(SourceControlRateLimit.Interactive, true),
  );

  const normalizeDestinationPath = Effect.fn("SourceControlRepositoryService.normalizeDestination")(
    function* (destinationPath: string) {
      const trimmed = destinationPath.trim();
      if (trimmed.length === 0) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: SourceControlProviderKind.make("unknown"),
          detail: "Choose a destination path before cloning.",
        });
      }

      return path.resolve(expandHomePath(trimmed, yield* HostProcess.HomeDirectory));
    },
  );

  const prepareDestination = Effect.fn("SourceControlRepositoryService.prepareDestination")(
    function* (destinationPath: string) {
      const normalizedDestination = yield* normalizeDestinationPath(destinationPath);
      const parentPath = path.dirname(normalizedDestination);
      if (yield* fileSystem.exists(normalizedDestination)) {
        const entries = yield* fileSystem
          .readDirectory(normalizedDestination, { recursive: false })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: SourceControlProviderKind.make("unknown"),
                  detail: "Destination path already exists and is not a directory.",
                  cause,
                }),
            ),
          );
        if (entries.length > 0) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "Destination path already exists and is not empty.",
          });
        }
      } else {
        // Skip existing parents: recursive mkdir on a Windows drive root fails with EPERM.
        if (!(yield* fileSystem.exists(parentPath))) {
          yield* fileSystem.makeDirectory(parentPath, { recursive: true });
        }
      }

      return {
        destinationPath: normalizedDestination,
        parentPath,
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
          provider: SourceControlProviderKind.make("unknown"),
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
   * `gh` picks a fork's parent as its base repository whenever several remotes exist, so adding
   * `upstream` without pinning the default repository would silently retarget `gh pr create`
   * and `gh issue list` at the parent project.
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

  /**
   * Wires a cloned fork to the repository it was forked from, after git has
   * finished. Both the synchronous clone and the tracked background clone call
   * this. The clone is already on disk and usable, so a fork whose parent could
   * not be wired up is a warning, not a failed clone.
   */
  const wireClonedFork = Effect.fn("SourceControlRepositoryService.wireClonedFork")(function* (
    input: SourceControlClonedForkInput,
  ) {
    const parentNameWithOwner = input.repository?.parentNameWithOwner ?? null;
    if (!input.repository || !parentNameWithOwner) return null;
    return yield* wireForkUpstream({
      cwd: input.cwd,
      provider: input.provider,
      parentNameWithOwner,
      protocol: resolveCloneProtocol(input.repository, input.cloneUrl, input.protocol),
      // `gh repo clone` would pick the parent here. The fork is the
      // repository the user asked to clone, so it is the default unless the
      // parent was chosen; either way the pin makes T3 and `gh` agree.
      defaultRepository: input.defaultRepository ?? "cloned",
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Fork upstream wiring failed after clone", {
          cwd: input.cwd,
          parent: parentNameWithOwner,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
  });

  const prepareClone = Effect.fn("SourceControlRepositoryService.prepareClone")(function* (
    input: SourceControlCloneRepositoryInput,
  ) {
    const preparedDestination = yield* prepareDestination(input.destinationPath);
    let repository: SourceControlRepositoryInfo | null = null;
    let remoteUrl = input.remoteUrl?.trim() ?? null;
    let provider: SourceControlProviderKind =
      input.provider ?? SourceControlProviderKind.make("unknown");

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
      if (repository && !remoteUrl) {
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

    return {
      destinationPath: preparedDestination.destinationPath,
      remoteUrl: redactRemoteUrl(remoteUrl),
      cloneUrl: remoteUrl,
      repository,
    } satisfies SourceControlPreparedClone;
  });

  const runClone = Effect.fn("SourceControlRepositoryService.runClone")(function* (
    input: SourceControlCloneRepositoryInput,
    destinationPath: string,
    cloneUrl: string,
    options?: SourceControlCloneOptions,
  ) {
    const onProgress = options?.onProgress;
    // Git mixes progress and diagnostics on stderr; retain non-progress tail lines for failure details.
    const stderrTail: Array<string> = [];
    const onStderrLine = (line: string) => {
      const parsed = parseGitCloneProgressLine(line);
      if (parsed) return onProgress ? onProgress(parsed) : Effect.void;
      return Effect.sync(() => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("Cloning into")) return;
        // Git echoes the remote in some failures; the tail becomes user-facing text.
        stderrTail.push(redactUrlCredentials(trimmed));
        if (stderrTail.length > 4) stderrTail.shift();
      });
    };
    yield* git
      .execute({
        operation: "SourceControlRepositoryService.cloneRepository",
        cwd: path.dirname(destinationPath),
        args: ["clone", "--progress", "--", cloneUrl, path.basename(destinationPath)],
        timeoutMs: options?.timeoutMs === undefined ? CLONE_TIMEOUT_MS : options.timeoutMs,
        // Buffered output is unused and progress can be huge; cap it while retaining line callbacks.
        maxOutputBytes: 256 * 1024,
        appendTruncationMarker: true,
        keepLineCallbacksAfterTruncation: true,
        env: CLONE_ENV,
        progress: { onStderrLine },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: input.provider ?? SourceControlProviderKind.make("unknown"),
              detail: describeCloneFailure(stderrTail, cause),
              cause,
            }),
        ),
      );
  });

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
    options?: SourceControlCloneOptions,
  ) {
    const prepared = yield* prepareClone(input);
    const httpsUrl = httpsFallbackUrl(input, prepared);
    const cloneUrl = yield* runClone(
      input,
      prepared.destinationPath,
      prepared.cloneUrl,
      options,
    ).pipe(
      Effect.as(prepared.cloneUrl),
      Effect.catch((sshError) =>
        httpsUrl === null || !isSshRejection(sshError)
          ? Effect.fail(sshError)
          : runClone(input, prepared.destinationPath, httpsUrl, options).pipe(
              Effect.as(httpsUrl),
              Effect.mapError(
                (httpsError) =>
                  new SourceControlRepositoryError({
                    operation: "cloneRepository",
                    provider: sshError.provider,
                    detail: `${sshError.detail} Cloning over HTTPS instead also failed: ${httpsError.detail}`,
                    cause: httpsError.cause,
                  }),
              ),
            ),
      ),
    );

    const upstream = yield* wireClonedFork({
      cwd: prepared.destinationPath,
      provider: input.provider ?? SourceControlProviderKind.make("unknown"),
      repository: prepared.repository,
      cloneUrl,
      protocol: input.protocol,
      defaultRepository: input.defaultRepository,
    });

    return {
      cwd: prepared.destinationPath,
      remoteUrl: redactRemoteUrl(cloneUrl),
      repository: prepared.repository,
      ...(upstream ? { upstream } : {}),
    };
  });

  const discardClone = Effect.fn("SourceControlRepositoryService.discardClone")(function* (
    destinationPath: string,
  ) {
    const normalized = yield* normalizeDestinationPath(destinationPath);
    // Only .git-bearing partial clones may be deleted; other files arrived after the empty-directory check.
    // Missing destinations are already discarded; other read failures must refuse removal.
    const entries = yield* fileSystem.readDirectory(normalized).pipe(
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed<ReadonlyArray<string>>([]),
      ),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "The clone destination could not be inspected.",
            cause,
          }),
      ),
    );
    if (entries.length > 0 && !entries.includes(".git")) {
      return yield* new SourceControlRepositoryError({
        operation: "discardClone",
        provider: SourceControlProviderKind.make("unknown"),
        detail: "Destination path contains files that are not from the clone.",
      });
    }
    // Preserve the workspace directory after removing partial contents; retry while interrupted git closes files.
    yield* fileSystem.remove(normalized, { recursive: true, force: true }).pipe(
      Effect.andThen(fileSystem.makeDirectory(normalized, { recursive: true })),
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 5 }),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: SourceControlProviderKind.make("unknown"),
            detail: "The partial clone could not be removed.",
            cause,
          }),
      ),
    );
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

      // Empty repos cannot push HEAD; report partial success because the remote already exists.
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

      const pushResult = yield* git.pushCurrentBranch(input.cwd, null, { remoteName }).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            // Reused remotes, pushurl, and URL rewrites can override the requested transport.
            const usesSsh = yield* git
              .execute({
                operation: "SourceControlRepositoryService.publishRepository.pushUrl",
                cwd: input.cwd,
                args: ["remote", "get-url", "--push", "--", remoteName],
              })
              .pipe(
                Effect.map((result) => isSshRemoteUrl(result.stdout)),
                Effect.orElseSucceed(() => false),
              );
            return yield* new SourceControlRepositoryError({
              operation: "publishRepository",
              provider: providerKind,
              detail: publishPushFailureDetail({
                urls,
                remoteName,
                usesSsh,
                reason: cause.reason,
              }),
              cause,
            });
          }),
        ),
      );

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

  /**
   * The host this checkout is read against. Taken from the remotes rather than the caller: a
   * hostname is where credentials get sent, which is not a body's text to decide.
   */
  const resolveReferenceHost = Effect.fn("SourceControlRepositoryService.resolveReferenceHost")(
    function* (cwd: string) {
      const config = yield* readRemoteConfig(cwd).pipe(Effect.orElseSucceed(() => null));
      const remotes = config?.state.remotes ?? [];
      const preferred =
        remotes.find((remote) => remote.remoteName === config?.state.defaultRemoteName) ??
        remotes.find((remote) => remote.remoteName === "origin") ??
        remotes[0];
      const host = preferred
        ? sourceControlDefinitions.repositoryKeyFromRemote(preferred.url).split("/")[0]
        : undefined;
      return host && host.length > 0 ? host : "github.com";
    },
  );

  const referenceCache = makeReferenceCache();

  const resolveReferences = Effect.fn("SourceControlRepositoryService.resolveReferences")(
    function* (input: SourceControlResolveReferencesInput) {
      const provider = yield* providers.resolve({ cwd: input.cwd });
      // One answer per reference however often a body names it, and a ceiling on the rest.
      const unique = new Map<string, SourceControlReference>();
      for (const reference of input.references) {
        unique.set(`${reference.repository.toLowerCase()}#${reference.number}`, reference);
        if (unique.size >= MAX_REFERENCES_PER_REQUEST) break;
      }
      if (unique.size === 0) {
        const host = yield* resolveReferenceHost(input.cwd);
        return {
          provider: provider.kind,
          host,
          references: [],
        } satisfies SourceControlResolveReferencesResult;
      }

      const host = yield* resolveReferenceHost(input.cwd);
      const now = yield* Clock.currentTimeMillis;
      const { cached, unanswered } = referenceCache.read(now, host, [...unique.values()]);
      if (unanswered.length === 0) {
        return {
          provider: provider.kind,
          host,
          references: cached,
        } satisfies SourceControlResolveReferencesResult;
      }

      const resolved = yield* provider.resolveReferences({
        cwd: input.cwd,
        host,
        references: unanswered,
      });
      referenceCache.write(now, host, resolved);
      return {
        provider: provider.kind,
        host,
        references: [...cached, ...resolved],
      } satisfies SourceControlResolveReferencesResult;
    },
  );

  return SourceControlRepositoryService.of({
    listIssues,
    getIssue,
    resolveReferences,
    lookupRepository: (input) =>
      lookupRepository(input).pipe(mapRepositoryError("lookupRepository", input.provider)),
    prepareClone: (input) =>
      prepareClone(input).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      ),
    cloneRepository: (input, options) =>
      cloneRepository(input, options).pipe(
        mapRepositoryError(
          "cloneRepository",
          input.provider ?? SourceControlProviderKind.make("unknown"),
        ),
      ),
    wireClonedFork,
    discardClone: (destinationPath) =>
      discardClone(destinationPath).pipe(
        mapRepositoryError("discardClone", SourceControlProviderKind.make("unknown")),
      ),
    publishRepository: (input) =>
      publishRepository(input).pipe(mapRepositoryError("publishRepository", input.provider)),
    getDefaultRepository: (input) =>
      getDefaultRepository(input).pipe(
        mapRepositoryError("getDefaultRepository", SourceControlProviderKind.make("unknown")),
      ),
    setDefaultRepository: (input) =>
      setDefaultRepository(input).pipe(
        mapRepositoryError("setDefaultRepository", SourceControlProviderKind.make("unknown")),
      ),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);
