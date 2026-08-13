import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import { GitCommandError, SourceControlProviderError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "./SourceControlRepositoryService.ts";

const CLONE_URLS = {
  nameWithOwner: "octocat/t3code",
  url: "https://github.com/octocat/t3code",
  sshUrl: "git@github.com:octocat/t3code.git",
};

const PARENT_URLS = {
  nameWithOwner: "t3/t3code",
  url: "https://github.com/t3/t3code",
  sshUrl: "git@github.com:t3/t3code.git",
};

const FORK_URLS = { ...CLONE_URLS, parentNameWithOwner: PARENT_URLS.nameWithOwner };

/** Answers the fork lookup and the follow-up parent lookup from one provider mock. */
function makeForkProvider() {
  return makeProvider({
    getRepositoryCloneUrls: (input) =>
      Effect.succeed(input.repository === PARENT_URLS.nameWithOwner ? PARENT_URLS : FORK_URLS),
  });
}

function makeProvider(
  overrides: Partial<SourceControlProvider.SourceControlProvider["Service"]> = {},
): SourceControlProvider.SourceControlProvider["Service"] {
  const unsupported = (operation: string) =>
    Effect.die(`unexpected provider operation ${operation}`) as Effect.Effect<
      never,
      SourceControlProviderError
    >;

  return {
    kind: "github",
    listChangeRequests: () => unsupported("listChangeRequests"),
    listIssues: () => unsupported("listIssues"),
    getIssue: () => unsupported("getIssue"),
    getChangeRequest: () => unsupported("getChangeRequest"),
    createChangeRequest: () => unsupported("createChangeRequest"),
    getRepositoryCloneUrls: () => Effect.succeed(CLONE_URLS),
    createRepository: () => Effect.succeed(CLONE_URLS),
    getDefaultBranch: () => Effect.succeed(null),
    checkoutChangeRequest: () => unsupported("checkoutChangeRequest"),
    ...overrides,
  };
}

function processOutput(): GitVcsDriver.ExecuteGitResult {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function makeLayer(input: {
  readonly provider?: SourceControlProvider.SourceControlProvider["Service"];
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
  readonly fileSystem?: FileSystem.FileSystem;
}) {
  const serviceLayer = SourceControlRepositoryService.layer.pipe(
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        get: () => Effect.succeed(input.provider ?? makeProvider()),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        execute: () => Effect.succeed(processOutput()),
        ensureRemote: () => Effect.succeed("origin"),
        resolvePrimaryRemoteName: () => Effect.succeed("origin"),
        fetchRemote: () => Effect.void,
        pushCurrentBranch: () =>
          Effect.succeed({
            status: "pushed" as const,
            branch: "feature/remote-v1",
            upstreamBranch: "origin/feature/remote-v1",
            setUpstream: true,
          }),
        ...input.git,
      }),
    ),
    Layer.provide(
      ServerConfig.layerTest(
        process.cwd(),
        input.fileSystem ? "/tmp/t3-source-control-repos" : { prefix: "t3-source-control-repos-" },
      ),
    ),
  );

  return input.fileSystem
    ? serviceLayer.pipe(
        Layer.provide(Layer.succeed(FileSystem.FileSystem, input.fileSystem)),
        Layer.provideMerge(NodePath.layer),
      )
    : serviceLayer.pipe(Layer.provideMerge(NodeServices.layer));
}

it.effect("looks up repositories through the requested provider without search", () => {
  const calls: Array<{ cwd: string; repository: string }> = [];
  const provider = makeProvider({
    getRepositoryCloneUrls: (input) =>
      Effect.sync(() => {
        calls.push({ cwd: input.cwd, repository: input.repository });
        return CLONE_URLS;
      }),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.lookupRepository({
      provider: "github",
      repository: "octocat/t3code",
      cwd: "/workspace",
    });

    assert.deepStrictEqual(result, { provider: "github", ...CLONE_URLS });
    assert.deepStrictEqual(calls, [{ cwd: "/workspace", repository: "octocat/t3code" }]);
  }).pipe(Effect.provide(makeLayer({ provider })));
});

it.effect("preserves provider failures without deriving the repository message from them", () => {
  const providerCause = new SourceControlProviderError({
    provider: "github",
    operation: "getRepositoryCloneUrls",
    cwd: "/workspace",
    repository: "octocat/t3code",
    detail: "credential token abc123 was rejected",
  });
  const provider = makeProvider({
    getRepositoryCloneUrls: () => Effect.fail(providerCause),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.lookupRepository({
        provider: "github",
        repository: "octocat/t3code",
        cwd: "/workspace",
      }),
    );

    assert.strictEqual(error.provider, "github");
    assert.strictEqual(error.operation, "lookupRepository");
    assert.strictEqual(error.detail, "The source control operation could not be completed.");
    assert.strictEqual(
      error.message,
      "Source control repository operation lookupRepository failed for github: The source control operation could not be completed.",
    );
    assert.strictEqual(error.cause, providerCause);
  }).pipe(Effect.provide(makeLayer({ provider })));
});

it.effect("clones a looked-up repository into the requested destination", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-clone-parent-",
    });
    const destinationPath = `${parent}/t3code`;
    const cloneCalls: Array<{ cwd: string; args: ReadonlyArray<string> }> = [];

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const result = yield* service.cloneRepository({
        provider: "github",
        repository: "octocat/t3code",
        destinationPath,
        protocol: "https",
      });

      assert.deepStrictEqual(result, {
        cwd: destinationPath,
        remoteUrl: CLONE_URLS.url,
        repository: { provider: "github", ...CLONE_URLS },
      });
      assert.deepStrictEqual(cloneCalls, [
        {
          cwd: parent,
          args: ["clone", CLONE_URLS.url, "t3code"],
        },
      ]);
      assert.strictEqual("upstream" in result, false);
    }).pipe(
      Effect.provide(
        makeLayer({
          git: {
            execute: (input) =>
              Effect.sync(() => {
                cloneCalls.push({ cwd: input.cwd, args: input.args });
                return processOutput();
              }),
          },
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

/** Answers `git config --get-regexp` for a fork clone that already has both remotes. */
function forkRemoteConfigStdout(defaultRemoteName: string | null): string {
  return [
    `remote.origin.url ${CLONE_URLS.url}`,
    `remote.upstream.url ${PARENT_URLS.url}`,
    ...(defaultRemoteName ? [`remote.${defaultRemoteName}.gh-resolved base`] : []),
  ].join("\n");
}

it.effect("lists remote candidates and the current default repository", () =>
  Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const state = yield* service.getDefaultRepository({ cwd: "/workspace" });

    assert.deepStrictEqual(state, {
      remotes: [
        {
          remoteName: "origin",
          url: CLONE_URLS.url,
          nameWithOwner: "octocat/t3code",
          provider: "github",
        },
        {
          remoteName: "upstream",
          url: PARENT_URLS.url,
          nameWithOwner: "t3/t3code",
          provider: "github",
        },
      ],
      defaultRemoteName: "upstream",
    });
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          execute: () =>
            Effect.succeed({ ...processOutput(), stdout: forkRemoteConfigStdout("upstream") }),
        },
      }),
    ),
  ),
);

it.effect("moves the default repository pin to the chosen remote", () => {
  const configCalls: Array<ReadonlyArray<string>> = [];

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    yield* service.setDefaultRepository({ cwd: "/workspace", remoteName: "origin" });

    assert.deepStrictEqual(configCalls, [
      ["config", "--unset-all", "remote.upstream.gh-resolved"],
      ["config", "--replace-all", "remote.origin.gh-resolved", "base"],
    ]);
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          execute: (input) =>
            Effect.sync(() => {
              if (input.args[1] !== "--get-regexp") {
                configCalls.push(input.args);
              }
              return { ...processOutput(), stdout: forkRemoteConfigStdout("upstream") };
            }),
        },
      }),
    ),
  );
});

it.effect("rejects a default repository that is not one of the remotes", () =>
  Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.setDefaultRepository({ cwd: "/workspace", remoteName: "fork" }),
    );

    assert.strictEqual(error.operation, "setDefaultRepository");
    assert.strictEqual(error.detail, "Choose a remote that exists in this repository.");
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          execute: () =>
            Effect.succeed({ ...processOutput(), stdout: forkRemoteConfigStdout(null) }),
        },
      }),
    ),
  ),
);

it.effect("clears every pin when the default repository is unset", () => {
  const configCalls: Array<ReadonlyArray<string>> = [];

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const state = yield* service.setDefaultRepository({ cwd: "/workspace", remoteName: null });

    assert.deepStrictEqual(configCalls, [["config", "--unset-all", "remote.upstream.gh-resolved"]]);
    // The mocked config keeps reporting the pin, so this asserts the read-back
    // shape rather than the cleared value.
    assert.strictEqual(state.remotes.length, 2);
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          execute: (input) =>
            Effect.sync(() => {
              if (input.args[1] !== "--get-regexp") {
                configCalls.push(input.args);
              }
              return { ...processOutput(), stdout: forkRemoteConfigStdout("upstream") };
            }),
        },
      }),
    ),
  );
});

it.effect("reports the repository a pin names when it is not the remote's own", () =>
  Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const state = yield* service.getDefaultRepository({ cwd: "/workspace" });

    // What `gh repo set-default` writes for a fork cloned without an upstream
    // remote: the pin lives on origin but names the parent repository.
    assert.strictEqual(state.defaultRemoteName, "origin");
    assert.strictEqual(state.defaultRepositoryPath, PARENT_URLS.nameWithOwner);
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          execute: () =>
            Effect.succeed({
              ...processOutput(),
              stdout: [
                `remote.origin.url ${CLONE_URLS.url}`,
                `remote.origin.gh-resolved ${PARENT_URLS.nameWithOwner}`,
              ].join("\n"),
            }),
        },
      }),
    ),
  ),
);

it.effect("reads remote names containing dots, and a repository with no remotes", () =>
  Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const state = yield* service.getDefaultRepository({ cwd: "/workspace" });

    assert.deepStrictEqual(
      state.remotes.map((remote) => remote.remoteName),
      ["my.fork"],
    );
    assert.strictEqual(state.defaultRemoteName, "my.fork");

    const empty = yield* service.getDefaultRepository({ cwd: "/empty" });
    assert.deepStrictEqual(empty, { remotes: [], defaultRemoteName: null });
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          execute: (input) =>
            Effect.succeed({
              ...processOutput(),
              stdout:
                input.cwd === "/empty"
                  ? ""
                  : [
                      `remote.my.fork.url ${CLONE_URLS.url}`,
                      "remote.my.fork.gh-resolved base",
                    ].join("\n"),
            }),
        },
      }),
    ),
  ),
);

it.effect("wires a cloned fork to its parent and pins the fork by default", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-clone-fork-",
    });
    const destinationPath = `${parent}/t3code`;
    const gitCalls: Array<{ cwd: string; args: ReadonlyArray<string> }> = [];
    const remoteCalls: Array<{ cwd: string; preferredName: string; url: string }> = [];

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const result = yield* service.cloneRepository({
        provider: "github",
        repository: "octocat/t3code",
        destinationPath,
        protocol: "https",
      });

      assert.deepStrictEqual(result.upstream, {
        remoteName: "upstream",
        nameWithOwner: PARENT_URLS.nameWithOwner,
        remoteUrl: PARENT_URLS.url,
      });
      assert.deepStrictEqual(remoteCalls, [
        { cwd: destinationPath, preferredName: "upstream", url: PARENT_URLS.url },
      ]);
      assert.deepStrictEqual(gitCalls, [
        { cwd: parent, args: ["clone", CLONE_URLS.url, "t3code"] },
        {
          cwd: destinationPath,
          args: ["config", "--replace-all", "remote.origin.gh-resolved", "base"],
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          provider: makeForkProvider(),
          git: {
            execute: (input) =>
              Effect.sync(() => {
                gitCalls.push({ cwd: input.cwd, args: input.args });
                return processOutput();
              }),
            ensureRemote: (input) =>
              Effect.sync(() => {
                remoteCalls.push(input);
                return "upstream";
              }),
          },
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("pins the parent when the clone asks to contribute upstream", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-clone-fork-parent-",
    });
    const destinationPath = `${parent}/t3code`;
    const gitCalls: Array<{ cwd: string; args: ReadonlyArray<string> }> = [];
    const remoteCalls: Array<{ cwd: string; preferredName: string; url: string }> = [];

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      yield* service.cloneRepository({
        provider: "github",
        repository: "octocat/t3code",
        destinationPath,
        protocol: "https",
        defaultRepository: "parent",
      });

      assert.deepStrictEqual(gitCalls, [
        { cwd: parent, args: ["clone", CLONE_URLS.url, "t3code"] },
        {
          cwd: destinationPath,
          args: ["config", "--replace-all", "remote.upstream.gh-resolved", "base"],
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          provider: makeForkProvider(),
          git: {
            execute: (input) =>
              Effect.sync(() => {
                gitCalls.push({ cwd: input.cwd, args: input.args });
                return processOutput();
              }),
            ensureRemote: (input) =>
              Effect.sync(() => {
                remoteCalls.push(input);
                return "upstream";
              }),
          },
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fetches the upstream remote, and keeps the clone when that fetch fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-clone-fork-fetch-",
    });
    const destinationPath = `${parent}/t3code`;
    const fetchCalls: Array<{ cwd: string; remoteName: string }> = [];

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const result = yield* service.cloneRepository({
        provider: "github",
        repository: "octocat/t3code",
        destinationPath,
      });

      assert.deepStrictEqual(fetchCalls, [{ cwd: destinationPath, remoteName: "upstream" }]);
      // The remote is wired up either way, so a failed fetch still reports it.
      assert.strictEqual(result.upstream?.remoteName, "upstream");
    }).pipe(
      Effect.provide(
        makeLayer({
          provider: makeForkProvider(),
          git: {
            ensureRemote: () => Effect.succeed("upstream"),
            fetchRemote: (input) =>
              Effect.sync(() => {
                fetchCalls.push(input);
              }).pipe(
                Effect.andThen(
                  new GitCommandError({
                    operation: "GitVcsDriver.fetchRemote",
                    command: "git fetch upstream",
                    cwd: input.cwd,
                    detail: "fatal: could not read from remote repository",
                  }),
                ),
              ),
          },
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps a fork clone when the upstream remote cannot be added", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-clone-fork-failure-",
    });
    const destinationPath = `${parent}/t3code`;

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const result = yield* service.cloneRepository({
        provider: "github",
        repository: "octocat/t3code",
        destinationPath,
      });

      assert.strictEqual(result.cwd, destinationPath);
      assert.strictEqual(result.upstream, undefined);
    }).pipe(
      Effect.provide(
        makeLayer({
          provider: makeForkProvider(),
          git: {
            ensureRemote: (input) =>
              new GitCommandError({
                operation: "GitVcsDriver.ensureRemote.add",
                command: "git remote add upstream",
                cwd: input.cwd,
                detail: "fatal: could not add remote",
              }),
          },
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("falls back to the requested clone URL when the repository lookup fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-clone-lookup-failure-",
    });
    const destinationPath = `${parent}/t3code`;
    const cloneCalls: Array<ReadonlyArray<string>> = [];

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const result = yield* service.cloneRepository({
        provider: "github",
        repository: "octocat/t3code",
        remoteUrl: CLONE_URLS.sshUrl,
        destinationPath,
      });

      assert.strictEqual(result.repository, null);
      assert.strictEqual(result.remoteUrl, CLONE_URLS.sshUrl);
      assert.deepStrictEqual(cloneCalls, [["clone", CLONE_URLS.sshUrl, "t3code"]]);
    }).pipe(
      Effect.provide(
        makeLayer({
          provider: makeProvider({
            getRepositoryCloneUrls: (input) =>
              new SourceControlProviderError({
                provider: "github",
                operation: "getRepositoryCloneUrls",
                cwd: input.cwd,
                repository: input.repository,
                detail: "gh is not authenticated",
              }),
          }),
          git: {
            execute: (input) =>
              Effect.sync(() => {
                cloneCalls.push(input.args);
                return processOutput();
              }),
          },
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preserves destination probe failures instead of treating them as missing paths", () => {
  const fileSystemCause = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "exists",
    pathOrDescriptor: "/restricted/t3code",
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.cloneRepository({
        remoteUrl: CLONE_URLS.sshUrl,
        destinationPath: "/restricted/t3code",
      }),
    );

    assert.strictEqual(error.provider, "unknown");
    assert.strictEqual(error.operation, "cloneRepository");
    assert.strictEqual(error.cause, fileSystemCause);
  }).pipe(
    Effect.provide(
      makeLayer({
        fileSystem: FileSystem.makeNoop({
          exists: () => Effect.fail(fileSystemCause),
          makeDirectory: () => Effect.void,
        }),
      }),
    ),
  );
});

it.effect("publishes by creating the repository, adding a remote, and pushing upstream", () => {
  const createCalls: Array<{ cwd: string; repository: string; visibility: string }> = [];
  const remoteCalls: Array<{ cwd: string; preferredName: string; url: string }> = [];
  const pushCalls: Array<{ cwd: string; remoteName: string | null | undefined }> = [];
  const provider = makeProvider({
    createRepository: (input) =>
      Effect.sync(() => {
        createCalls.push({
          cwd: input.cwd,
          repository: input.repository,
          visibility: input.visibility,
        });
        return CLONE_URLS;
      }),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.deepStrictEqual(result, {
      repository: { provider: "github", ...CLONE_URLS },
      remoteName: "origin",
      remoteUrl: CLONE_URLS.sshUrl,
      branch: "feature/remote-v1",
      upstreamBranch: "origin/feature/remote-v1",
      status: "pushed",
    });
    assert.deepStrictEqual(createCalls, [
      { cwd: "/workspace", repository: "octocat/t3code", visibility: "private" },
    ]);
    assert.deepStrictEqual(remoteCalls, [
      { cwd: "/workspace", preferredName: "origin", url: CLONE_URLS.sshUrl },
    ]);
    assert.deepStrictEqual(pushCalls, [{ cwd: "/workspace", remoteName: "origin" }]);
  }).pipe(
    Effect.provide(
      makeLayer({
        provider,
        git: {
          ensureRemote: (input) =>
            Effect.sync(() => {
              remoteCalls.push(input);
              return "origin";
            }),
          pushCurrentBranch: (cwd, _fallbackBranch, options) =>
            Effect.sync(() => {
              pushCalls.push({ cwd, remoteName: options?.remoteName });
              return {
                status: "pushed" as const,
                branch: "feature/remote-v1",
                upstreamBranch: "origin/feature/remote-v1",
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

it.effect("publishes to the remote name returned by ensureRemote", () => {
  const pushCalls: Array<{ cwd: string; remoteName: string | null | undefined }> = [];

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.equal(result.remoteName, "origin-1");
    assert.deepStrictEqual(pushCalls, [{ cwd: "/workspace", remoteName: "origin-1" }]);
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          ensureRemote: () => Effect.succeed("origin-1"),
          pushCurrentBranch: (cwd, _fallbackBranch, options) =>
            Effect.sync(() => {
              pushCalls.push({ cwd, remoteName: options?.remoteName });
              return {
                status: "pushed" as const,
                branch: "feature/remote-v1",
                upstreamBranch: `${options?.remoteName ?? "missing"}/feature/remote-v1`,
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

it.effect("publish succeeds with status remote_added when the local repo has no commits", () => {
  let pushCalls = 0;
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.deepStrictEqual(result, {
      repository: { provider: "github", ...CLONE_URLS },
      remoteName: "origin",
      remoteUrl: CLONE_URLS.sshUrl,
      branch: "main",
      status: "remote_added",
    });
    assert.strictEqual(pushCalls, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          execute: (input) =>
            input.args[0] === "rev-parse"
              ? Effect.fail(
                  new GitCommandError({
                    operation: input.operation,
                    command: "git rev-parse --verify HEAD",
                    cwd: input.cwd,
                    detail: "fatal: Needed a single revision",
                  }),
                )
              : Effect.succeed(processOutput()),
          statusDetails: () =>
            Effect.succeed({
              isRepo: true,
              hasOriginRemote: true,
              isDefaultBranch: true,
              branch: "main",
              upstreamRef: null,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
              hasUpstream: false,
              aheadCount: 0,
              behindCount: 0,
              aheadOfDefaultCount: 0,
            }),
          pushCurrentBranch: () =>
            Effect.sync(() => {
              pushCalls += 1;
              return {
                status: "pushed" as const,
                branch: "main",
                upstreamBranch: "origin/main",
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});
