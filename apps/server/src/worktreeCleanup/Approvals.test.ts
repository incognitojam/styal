import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProjectId } from "@t3tools/contracts";
import { fixture, nodeLayer } from "./fixtures.testkit.ts";
import * as Approvals from "./Approvals.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectConfigLoader from "../project/ProjectConfigLoader.ts";
import * as Settings from "../serverSettings.ts";

it.effect(
  "retains earlier approvals, forgets them, ignores undeclared additions and keeps projects independent",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const projectId = ProjectId.make("a");
      const input = { projectId };
      const projectLayer = Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeedSome({
            id,
            title: "Synthetic",
            workspaceRoot: f.root,
            repositoryIdentity: null,
            faviconPath: null,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            deletedAt: null,
          }),
      });
      const base = Approvals.layer.pipe(
        Layer.provide(Layer.mergeAll(projectLayer, ProjectConfigLoader.layer)),
      );
      yield* Effect.gen(function* () {
        const approvals = yield* Approvals.Approvals;
        const write = (value: string) => f.fs.writeFileString(`${f.root}/styal.json`, value);
        yield* write('{"worktreeCleanup":["dist"]}');
        expect((yield* approvals.review(input)).declared).toEqual([
          { pattern: "dist", status: "pending" },
        ]);
        yield* approvals.approve({ ...input, patterns: ["dist"] });
        expect((yield* approvals.review({ projectId: ProjectId.make("b") })).status).toBe(
          "pending",
        );
        yield* write('{"worktreeCleanup":["dist","node_modules"]}');
        expect((yield* approvals.review(input)).declared).toEqual([
          { pattern: "dist", status: "approved" },
          { pattern: "node_modules", status: "pending" },
        ]);
        yield* write('{"worktreeCleanup":["node_modules"]}');
        expect(
          (yield* approvals.review(input)).approvedNotDeclared.map((entry) => entry.pattern),
        ).toEqual(["dist"]);
        expect(
          (yield* approvals.approve({ ...input, patterns: ["dist", "**/*"] })).notDeclared,
        ).toEqual(["dist", "**/*"]);
        yield* write('{"worktreeCleanup":["dist"]}');
        expect((yield* approvals.review(input)).status).toBe("approved");
        yield* write("{}");
        expect((yield* approvals.review(input)).status).toBe("none");
        yield* approvals.revoke({ ...input, pattern: "dist" });
        yield* write('{"worktreeCleanup":["dist"]}');
        expect((yield* approvals.review(input)).status).toBe("pending");
        yield* write('{"worktreeCleanup":["**/*"]}');
        expect(
          (yield* approvals.approve({ ...input, patterns: ["**/*"] }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* write('{"worktreeCleanup":["dist","node_modules"]}');
        yield* approvals.approve({ ...input, patterns: ["dist"] });
        const settings = yield* Settings.ServerSettingsService;
        yield* approvals.revoke({ ...input, pattern: null });
        expect((yield* settings.getSettings).worktreeCleanupApprovals).toEqual({});
      }).pipe(Effect.provide(base));
    }).pipe(Effect.provide(Layer.mergeAll(Settings.layerTest(), nodeLayer)), Effect.scoped),
);
