import { SourceControlProviderKind } from "@t3tools/contracts";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import { GitCommandError, SourceControlProviderError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
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
    kind: SourceControlProviderKind.make("github"),
    listChangeRequests: () => unsupported("listChangeRequests"),
    listIssues: () => unsupported("listIssues"),
    getIssue: () => unsupported("getIssue"),
    resolveReferences: () => unsupported("resolveReferences"),
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

function layer(input: {
  readonly provider?: SourceControlProvider.SourceControlProvider["Service"];
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
  readonly fileSystem?: FileSystem.FileSystem;
  readonly pathLayer?: typeof NodePath.layer;
}) {
  const layerService = SourceControlRepositoryService.layer.pipe(
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => undefined,
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
    ? layerService.pipe(
        Layer.provide(Layer.succeed(FileSystem.FileSystem, input.fileSystem)),
        Layer.provideMerge(input.pathLayer ?? NodePath.layer),
      )
    : layerService.pipe(Layer.provideMerge(NodeServices.layer));
}

it.effect("clones a looked-up repository after creating missing parent directories", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-clone-parent-",
    });
    const parent = path.join(temporaryDirectory, "missing", "nested");
    const destinationPath = path.join(parent, "t3code");
    const cloneCalls: Array<{ cwd: string; args: ReadonlyArray<string> }> = [];

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const result = yield* service.cloneRepository({
        provider: SourceControlProviderKind.make("github"),
        repository: "octocat/t3code",
        destinationPath,
        protocol: "https",
      });

      assert.deepStrictEqual(result, {
        cwd: destinationPath,
        remoteUrl: CLONE_URLS.url,
        repository: { provider: SourceControlProviderKind.make("github"), ...CLONE_URLS },
      });
      assert.deepStrictEqual(cloneCalls, [
        {
          cwd: parent,
          args: ["clone", "--progress", "--", CLONE_URLS.url, "t3code"],
        },
      ]);
      assert.strictEqual("upstream" in result, false);
    }).pipe(
      Effect.provide(
        layer({
          git: {
            execute: (input) =>
              Effect.gen(function* () {
                assert.isTrue(yield* fs.exists(parent).pipe(Effect.orDie));
                cloneCalls.push({ cwd: input.cwd, args: input.args });
                return processOutput();
              }),
          },
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["--bare", "source.git"])(
  "clones a local repository named %s as a working tree",
  (repositoryName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-clone-options-" });
      yield* git.execute({
        operation: "test.init",
        cwd: parent,
        args: ["init", "--bare", path.join(parent, repositoryName)],
      });
      const destinationPath = path.join(parent, "checkout");
      yield* Effect.gen(function* () {
        const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
        const result = yield* service.cloneRepository({
          remoteUrl: repositoryName,
          destinationPath,
        });
        assert.strictEqual(result.cwd, destinationPath);
        assert.isTrue(yield* fs.exists(path.join(destinationPath, ".git")));
      }).pipe(Effect.provide(layer({ git: { execute: git.execute } })));
    }).pipe(
      Effect.provide(
        GitVcsDriver.layer.pipe(
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "t3-clone-options-config-",
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect("reports clone progress from git's stderr and keeps its error text on failure", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-clone-progress-",
    });
    const destinationPath = path.join(parent, "t3code");
    const progress: Array<{ stage: string; percent: number | null; detail: string | null }> = [];

    const stderrLines = [
      "Cloning into 't3code'...",
      "remote: Enumerating objects: 10, done.",
      "Receiving objects:  40% (4/10), 1.00 MiB | 2.00 MiB/s",
      "Receiving objects: 100% (10/10), 2.50 MiB | 2.00 MiB/s, done.",
      "fatal: early EOF",
      "fatal: unable to access 'https://user:s3c@ret@github.com/octocat/t3code.git/': could not resolve host",
    ];
    const error = yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      return yield* Effect.flip(
        service.cloneRepository(
          { remoteUrl: CLONE_URLS.sshUrl, destinationPath },
          { onProgress: (line) => Effect.sync(() => void progress.push(line)) },
        ),
      );
    }).pipe(
      Effect.provide(
        layer({
          git: {
            execute: (input) =>
              Effect.gen(function* () {
                for (const line of stderrLines) {
                  yield* input.progress?.onStderrLine?.(line) ?? Effect.void;
                }
                return yield* new GitCommandError({
                  operation: input.operation,
                  command: "git",
                  cwd: input.cwd,
                  detail: "Git command exited with a non-zero status.",
                  exitCode: 128,
                });
              }),
          },
        }),
      ),
    );

    assert.deepStrictEqual(progress, [
      { stage: "counting", percent: null, detail: null },
      { stage: "receiving", percent: 40, detail: "1.00 MiB | 2.00 MiB/s" },
      { stage: "receiving", percent: 100, detail: "2.50 MiB | 2.00 MiB/s" },
    ]);
    assert.strictEqual(
      error.detail,
      "fatal: early EOF fatal: unable to access 'https://github.com/octocat/t3code.git/': could not resolve host",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("strips embedded credentials from the remote URL it reports", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-source-control-redact-" });
    const destinationPath = path.join(parent, "t3code");
    const cloneArgs: Array<ReadonlyArray<string>> = [];
    const result = yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      return yield* service.prepareClone({
        remoteUrl: "https://user:s3cret@github.com/octocat/t3code.git",
        destinationPath,
      });
    }).pipe(
      Effect.provide(
        layer({
          git: {
            execute: (input) =>
              Effect.sync(() => {
                cloneArgs.push(input.args);
                return processOutput();
              }),
          },
        }),
      ),
    );
    assert.equal(result.remoteUrl, "https://github.com/octocat/t3code.git");
    assert.equal(result.cloneUrl, "https://user:s3cret@github.com/octocat/t3code.git");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("discards only a directory git wrote to", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-source-control-discard-" });
    const partial = path.join(parent, "partial");
    yield* fs.makeDirectory(path.join(partial, ".git"), { recursive: true });
    yield* fs.writeFileString(path.join(partial, "README.md"), "half");
    const foreign = path.join(parent, "foreign");
    yield* fs.makeDirectory(foreign);
    yield* fs.writeFileString(path.join(foreign, "notes.txt"), "mine");

    const replaced = path.join(parent, "replaced");
    yield* fs.writeFileString(replaced, "not a directory");

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      yield* service.discardClone(partial);
      const error = yield* Effect.flip(service.discardClone(foreign));
      assert.include(error.detail, "not from the clone");
      const replacedError = yield* Effect.flip(service.discardClone(replaced));
      assert.include(replacedError.detail, "could not be inspected");
      yield* service.discardClone(path.join(parent, "missing"));
    }).pipe(Effect.provide(layer({})));

    assert.deepStrictEqual(yield* fs.readDirectory(partial), []);
    assert.deepStrictEqual(yield* fs.readDirectory(foreign), ["notes.txt"]);
    assert.strictEqual(yield* fs.readFileString(replaced), "not a directory");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("redacts query tokens and userinfo containing '@' from reported URLs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-source-control-redact2-" });
    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const query = yield* service.prepareClone({
        remoteUrl: "https://github.com/octocat/t3code.git?access_token=s3cret",
        destinationPath: path.join(parent, "a"),
      });
      assert.equal(query.remoteUrl, "https://github.com/octocat/t3code.git");
      const nested = yield* service.prepareClone({
        remoteUrl: "https://user:pa@rt@github.com/octocat/t3code.git",
        destinationPath: path.join(parent, "b"),
      });
      assert.equal(nested.remoteUrl, "https://github.com/octocat/t3code.git");
    }).pipe(Effect.provide(layer({})));
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
          provider: SourceControlProviderKind.make("github"),
        },
        {
          remoteName: "upstream",
          url: PARENT_URLS.url,
          nameWithOwner: "t3/t3code",
          provider: SourceControlProviderKind.make("github"),
        },
      ],
      defaultRemoteName: "upstream",
    });
  }).pipe(
    Effect.provide(
      layer({
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
      layer({
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
      layer({
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
      layer({
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
      layer({
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
      layer({
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

it.effect("keeps the client-resolved fork transport when wiring and pinning its parent", () =>
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
        provider: SourceControlProviderKind.make("github"),
        repository: "octocat/t3code",
        remoteUrl: CLONE_URLS.url,
        destinationPath,
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
        { cwd: parent, args: ["clone", "--progress", "--", CLONE_URLS.url, "t3code"] },
        {
          cwd: destinationPath,
          args: ["config", "--replace-all", "remote.origin.gh-resolved", "base"],
        },
      ]);
    }).pipe(
      Effect.provide(
        layer({
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

it.effect("infers SSH upstreams for SSH fork URLs and custom URL fallbacks", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const remoteCalls: Array<{ cwd: string; preferredName: string; url: string }> = [];
    const cases = [
      { directory: "ssh", remoteUrl: CLONE_URLS.sshUrl },
      { directory: "custom", remoteUrl: "https://mirror.example.test/octocat/t3code.git" },
    ] as const;

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      for (const testCase of cases) {
        const parent = yield* fs.makeTempDirectoryScoped({
          prefix: `t3-source-control-clone-fork-${testCase.directory}-`,
        });
        const destinationPath = `${parent}/t3code`;
        const result = yield* service.cloneRepository({
          provider: SourceControlProviderKind.make("github"),
          repository: "octocat/t3code",
          remoteUrl: testCase.remoteUrl,
          destinationPath,
        });

        assert.strictEqual(result.remoteUrl, testCase.remoteUrl);
        assert.strictEqual(result.upstream?.remoteUrl, PARENT_URLS.sshUrl);
      }

      assert.deepStrictEqual(
        remoteCalls.map(({ url }) => url),
        [PARENT_URLS.sshUrl, PARENT_URLS.sshUrl],
      );
    }).pipe(
      Effect.provide(
        layer({
          provider: makeForkProvider(),
          git: {
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
        provider: SourceControlProviderKind.make("github"),
        repository: "octocat/t3code",
        destinationPath,
        protocol: "https",
        defaultRepository: "parent",
      });

      assert.deepStrictEqual(gitCalls, [
        { cwd: parent, args: ["clone", "--progress", "--", CLONE_URLS.url, "t3code"] },
        {
          cwd: destinationPath,
          args: ["config", "--replace-all", "remote.upstream.gh-resolved", "base"],
        },
      ]);
    }).pipe(
      Effect.provide(
        layer({
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
        provider: SourceControlProviderKind.make("github"),
        repository: "octocat/t3code",
        destinationPath,
      });

      assert.deepStrictEqual(fetchCalls, [{ cwd: destinationPath, remoteName: "upstream" }]);
      // The remote is wired up either way, so a failed fetch still reports it.
      assert.strictEqual(result.upstream?.remoteName, "upstream");
    }).pipe(
      Effect.provide(
        layer({
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
        provider: SourceControlProviderKind.make("github"),
        repository: "octocat/t3code",
        destinationPath,
      });

      assert.strictEqual(result.cwd, destinationPath);
      assert.strictEqual(result.upstream, undefined);
    }).pipe(
      Effect.provide(
        layer({
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
        provider: SourceControlProviderKind.make("github"),
        repository: "octocat/t3code",
        remoteUrl: CLONE_URLS.sshUrl,
        destinationPath,
      });

      assert.strictEqual(result.repository, null);
      assert.strictEqual(result.remoteUrl, CLONE_URLS.sshUrl);
      assert.deepStrictEqual(cloneCalls, [
        ["clone", "--progress", "--", CLONE_URLS.sshUrl, "t3code"],
      ]);
    }).pipe(
      Effect.provide(
        layer({
          provider: makeProvider({
            getRepositoryCloneUrls: (input) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("github"),
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

it.effect.each([
  [
    "missing HTTPS credentials",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "Git authentication failed.",
  ],
  [
    "missing password",
    "fatal: could not read Password for 'https://user@github.com': No such device or address",
    "Git authentication failed.",
  ],
  [
    "SSH authentication",
    "git@github.com: Permission denied (publickey).",
    "Git authentication failed.",
  ],
  [
    "rate limiting",
    "remote: Too many requests (HTTP 429)",
    "The Git host rate limit was exceeded.",
  ],
] as const)(
  "explains clone %s with recovery guidance in place of git's output",
  ([_name, stderr, expectedDetail]) =>
    Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const error = yield* Effect.flip(
        service.cloneRepository({
          remoteUrl: CLONE_URLS.url,
          destinationPath: "/projects/t3code",
        }),
      );

      assert.strictEqual(error.operation, "cloneRepository");
      assert.isTrue(error.detail.startsWith(expectedDetail));
      assert.notInclude(error.message, stderr);
      if (expectedDetail === "Git authentication failed.") {
        assert.include(error.detail, "Git credentials or SSH keys");
        assert.include(error.detail, "gh auth login and gh auth setup-git");
      }
    }).pipe(
      Effect.provide(
        layer({
          fileSystem: FileSystem.makeNoop({
            exists: () => Effect.succeed(false),
            makeDirectory: () => Effect.void,
          }),
          git: {
            execute: (input) =>
              Effect.gen(function* () {
                yield* input.progress?.onStderrLine?.(stderr) ?? Effect.void;
                return yield* new GitCommandError({
                  operation: input.operation,
                  command: "git",
                  cwd: input.cwd,
                  detail: "Git command exited with a non-zero status.",
                  exitCode: 128,
                });
              }),
          },
        }),
      ),
    ),
);

it.effect("preserves clone process failures such as timeouts", () =>
  Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.cloneRepository({
        remoteUrl: CLONE_URLS.url,
        destinationPath: "/projects/t3code",
      }),
    );
    assert.strictEqual(error.detail, "Git command timed out.");
  }).pipe(
    Effect.provide(
      layer({
        fileSystem: FileSystem.makeNoop({
          exists: () => Effect.succeed(false),
          makeDirectory: () => Effect.void,
        }),
        git: {
          execute: (input) =>
            Effect.fail(
              new GitCommandError({
                operation: input.operation,
                command: "git",
                cwd: input.cwd,
                detail: "Git command timed out.",
              }),
            ),
        },
      }),
    ),
  ),
);

it.effect("clones beneath a Windows drive root without trying to create the root", () => {
  const cloneCalls: Array<{ cwd: string; args: ReadonlyArray<string> }> = [];

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.cloneRepository({
      remoteUrl: CLONE_URLS.url,
      destinationPath: "D:\\t3code",
    });

    assert.strictEqual(result.cwd, "D:\\t3code");
    assert.deepStrictEqual(cloneCalls, [
      { cwd: "D:\\", args: ["clone", "--progress", "--", CLONE_URLS.url, "t3code"] },
    ]);
  }).pipe(
    Effect.provide(
      layer({
        pathLayer: NodePath.layerWin32,
        fileSystem: FileSystem.makeNoop({
          exists: (path) => Effect.succeed(path === "D:\\"),
          makeDirectory: (path) =>
            path === "D:\\"
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "makeDirectory",
                    pathOrDescriptor: path,
                  }),
                )
              : Effect.void,
        }),
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
});

it.effect("creates missing parent directories before cloning", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-source-control-clone-parent-" });
    const parent = `${root}/projects/nested`;

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      yield* service.cloneRepository({
        remoteUrl: CLONE_URLS.url,
        destinationPath: `${parent}/t3code`,
      });
    }).pipe(
      Effect.provide(
        layer({
          git: {
            execute: (input) =>
              Effect.gen(function* () {
                assert.strictEqual(input.cwd, parent);
                assert.strictEqual((yield* fs.stat(parent).pipe(Effect.orDie)).type, "Directory");
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
      layer({
        fileSystem: FileSystem.makeNoop({
          exists: () => Effect.fail(fileSystemCause),
          makeDirectory: () => Effect.void,
        }),
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
      provider: SourceControlProviderKind.make("github"),
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.equal(result.remoteName, "origin-1");
    assert.deepStrictEqual(pushCalls, [{ cwd: "/workspace", remoteName: "origin-1" }]);
  }).pipe(
    Effect.provide(
      layer({
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

function failingPush(reason?: GitCommandError["reason"]) {
  return {
    pushCurrentBranch: (cwd: string) =>
      Effect.fail(
        new GitCommandError({
          operation: "GitVcsDriver.pushCurrentBranch.pushWithRequestedRemote",
          command: "git",
          cwd,
          ...(reason === undefined ? {} : { reason }),
          detail: "Git command exited with a non-zero status.",
        }),
      ),
  } satisfies Partial<GitVcsDriver.GitVcsDriver["Service"]>;
}

it.effect("explains a rejected SSH push after creating the repository", () =>
  Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.publishRepository({
        cwd: "/workspace",
        provider: SourceControlProviderKind.make("github"),
        repository: "octocat/t3code",
        visibility: "private",
        protocol: "ssh",
      }),
    );

    assert.strictEqual(error.operation, "publishRepository");
    assert.strictEqual(
      error.detail,
      'Created octocat/t3code and added it as remote "origin", but the push failed because SSH authentication was rejected. Add an SSH key to your account, or switch the remote to HTTPS with "git remote set-url origin https://github.com/octocat/t3code", then push again.',
    );
    assert.instanceOf(error.cause, GitCommandError);
  }).pipe(
    Effect.provide(
      layer({
        git: {
          ...failingPush("authentication_failed"),
          execute: () => Effect.succeed({ ...processOutput(), stdout: CLONE_URLS.sshUrl }),
        },
      }),
    ),
  ),
);

it.effect.each([
  { protocol: "auto" as const, remoteUrl: CLONE_URLS.url, usesSsh: false },
  { protocol: "ssh" as const, remoteUrl: CLONE_URLS.url, usesSsh: false },
  { protocol: "https" as const, remoteUrl: CLONE_URLS.sshUrl, usesSsh: true },
  {
    protocol: "auto" as const,
    remoteUrl: CLONE_URLS.sshUrl,
    pushUrl: "https://synthetic-user:synthetic-token@github.com/octocat/t3code.git",
    usesSsh: false,
  },
  {
    protocol: "https" as const,
    remoteUrl: CLONE_URLS.url,
    pushUrl: "ssh://git@github.com/octocat/t3code.git",
    usesSsh: true,
  },
])("explains publish authentication failures using the effective push transport: %j", (testCase) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const cwd = yield* fs.makeTempDirectoryScoped({
      directory: `${import.meta.dirname}/../../../../.scratch`,
      prefix: "push-failure-transport-repo-",
    });
    for (const args of [
      ["init"],
      [
        "-c",
        "user.name=Synthetic Author",
        "-c",
        "user.email=author@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "Initial commit",
      ],
      ["remote", "add", "publish-target", testCase.remoteUrl],
      ...(testCase.pushUrl
        ? [["remote", "set-url", "--push", "publish-target", testCase.pushUrl]]
        : []),
    ]) {
      yield* git.execute({ operation: "test.setup", cwd, args });
    }

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const error = yield* Effect.flip(
        service.publishRepository({
          cwd,
          provider: SourceControlProviderKind.make("github"),
          repository: CLONE_URLS.nameWithOwner,
          visibility: "private",
          protocol: testCase.protocol,
        }),
      );
      assert.include(error.detail, 'remote "publish-target"');
      assert.include(
        error.detail,
        testCase.usesSsh ? "SSH authentication was rejected" : "Check your Git credentials",
      );
      if (!testCase.usesSsh) assert.notInclude(error.detail, "Add an SSH key");
      assert.notInclude(error.detail, "synthetic-user");
      assert.notInclude(error.detail, "synthetic-token");
      assert.instanceOf(error.cause, GitCommandError);
      const remotes = yield* git.execute({ operation: "test.remotes", cwd, args: ["remote"] });
      assert.strictEqual(remotes.stdout.trim(), "publish-target");
    }).pipe(
      Effect.provide(
        layer({
          git: {
            execute: git.execute,
            ensureRemote: git.ensureRemote,
            ...failingPush("authentication_failed"),
          },
        }),
      ),
    );
  }).pipe(
    Effect.provide(
      GitVcsDriver.layer.pipe(
        Layer.provide(
          ServerConfig.layerTest(
            process.cwd(),
            `${import.meta.dirname}/../../../../.scratch/push-failure-transport-config`,
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("preserves the push failure when its effective URL cannot be read", () =>
  Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.publishRepository({
        cwd: "/workspace",
        provider: SourceControlProviderKind.make("github"),
        repository: CLONE_URLS.nameWithOwner,
        visibility: "private",
        protocol: "ssh",
      }),
    );
    assert.include(error.detail, "Check your Git credentials");
    assert.instanceOf(error.cause, GitCommandError);
    assert.strictEqual(error.cause.reason, "authentication_failed");
  }).pipe(
    Effect.provide(
      layer({
        git: {
          ...failingPush("authentication_failed"),
          execute: (input) =>
            input.args[0] === "rev-parse"
              ? Effect.succeed(processOutput())
              : Effect.fail(
                  new GitCommandError({
                    operation: input.operation,
                    command: "git",
                    cwd: input.cwd,
                    detail: "The remote could not be read.",
                  }),
                ),
        },
      }),
    ),
  ),
);

// regression: #19219 publishing did not explain why the first push failed
it.effect("says the repository exists when an unclassified publish push fails", () =>
  Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.publishRepository({
        cwd: "/workspace",
        provider: SourceControlProviderKind.make("github"),
        repository: "octocat/t3code",
        visibility: "private",
        protocol: "https",
      }),
    );

    assert.strictEqual(
      error.detail,
      'Created octocat/t3code and added it as remote "origin", but the push failed. Fix the problem, then push again.',
    );
  }).pipe(Effect.provide(layer({ git: failingPush() }))),
);

it.effect("publish succeeds with status remote_added when the local repo has no commits", () => {
  let pushCalls = 0;
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: SourceControlProviderKind.make("github"),
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.deepStrictEqual(result, {
      repository: { provider: SourceControlProviderKind.make("github"), ...CLONE_URLS },
      remoteName: "origin",
      remoteUrl: CLONE_URLS.sshUrl,
      branch: "main",
      status: "remote_added",
    });
    assert.strictEqual(pushCalls, 0);
  }).pipe(
    Effect.provide(
      layer({
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
              hasHeadCommit: true,
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
