/**
 * Approval covers one exact command read from the project's own file, not from the client, so
 * it cannot be pointed at a command the user did not see. Only user clients reach `setApproved`,
 * so an agent that edits styal.json cannot approve itself.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  ProjectFileActionApprovalError,
  type Project,
  type ProjectConfig,
  type ProjectFileActionApprovalInput,
  type ProjectFileActionReview,
} from "@t3tools/contracts";
import {
  commandFileCandidates,
  declaredFileActionRoles,
  projectFileApprovalKey,
} from "@t3tools/shared/projectFileApprovals";

import * as ServerSettings from "../serverSettings.ts";
import * as ProjectConfigLoader from "./ProjectConfigLoader.ts";
import * as ProjectService from "./ProjectService.ts";

const MAX_HINT_FILES = 2;

/** Service tag for styal.json action approvals. */
export class ProjectFileActionApprovals extends Context.Service<
  ProjectFileActionApprovals,
  {
    /**
     * The configuration automatic file actions come from. Every automatic
     * run and every approval reads through this, so where that is (today the
     * project root's working tree) is decided in one place.
     */
    readonly automationConfig: (
      project: Pick<Project, "workspaceRoot">,
    ) => Effect.Effect<ProjectConfig | null>;
    /** What approving the action would cover now. */
    readonly review: (
      input: ProjectFileActionApprovalInput,
    ) => Effect.Effect<ProjectFileActionReview, ProjectFileActionApprovalError>;
    /** Approve the command the file has now, for every role it declares, or revoke. */
    readonly setApproved: (
      input: ProjectFileActionApprovalInput & { readonly approved: boolean },
    ) => Effect.Effect<ProjectFileActionReview, ProjectFileActionApprovalError>;
  }
>()("@styal/cli/project/ProjectFileActionApprovals") {}

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const configLoader = yield* ProjectConfigLoader.ProjectConfigLoader;
  const settingsService = yield* ServerSettings.ServerSettingsService;

  const automationConfig = (project: Pick<Project, "workspaceRoot">) =>
    configLoader.load(project.workspaceRoot).pipe(Effect.map((state) => state.config));

  const fail = (reason: ProjectFileActionApprovalError["reason"], message: string) =>
    new ProjectFileActionApprovalError({ reason, message });

  const isFile = (relativePath: string, root: string) =>
    fileSystem.stat(path.join(root, relativePath)).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );

  const packageScripts = (root: string) =>
    fileSystem.readFileString(path.join(root, "package.json")).pipe(
      Effect.map((contents): ReadonlySet<string> => {
        try {
          const parsed: unknown = JSON.parse(contents);
          const scripts =
            typeof parsed === "object" && parsed !== null && "scripts" in parsed
              ? parsed.scripts
              : undefined;
          return new Set(
            typeof scripts === "object" && scripts !== null ? Object.keys(scripts) : [],
          );
        } catch {
          return new Set();
        }
      }),
      Effect.orElseSucceed((): ReadonlySet<string> => new Set()),
    );

  // A best-effort reading of the command for the approval's warning; a miss
  // only means the generic wording.
  const hintFor = Effect.fn("ProjectFileActionApprovals.hintFor")(function* (
    command: string,
    root: string,
  ) {
    const candidates = commandFileCandidates(command);
    const files: string[] = [];
    for (const candidate of candidates.paths) {
      if (files.length === MAX_HINT_FILES) break;
      if (yield* isFile(candidate, root)) files.push(candidate);
    }
    if (files.length > 0) return { kind: "files" as const, paths: files };
    if (candidates.packageScripts.length > 0) {
      const scripts = yield* packageScripts(root);
      const script = candidates.packageScripts.find((name) => scripts.has(name));
      if (script !== undefined) return { kind: "package-script" as const, script };
    }
    return { kind: "none" as const };
  });

  const resolve = Effect.fn("ProjectFileActionApprovals.resolve")(function* (
    input: ProjectFileActionApprovalInput,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (project === undefined) {
      return yield* fail("project-not-found", "The project no longer exists.");
    }
    const config = yield* automationConfig(project);
    const action = config?.actions.find((candidate) => candidate.id === input.actionId);
    if (action === undefined) {
      return yield* fail("action-not-found", "styal.json no longer has this action.");
    }
    return { project, action, key: projectFileApprovalKey(project) };
  });

  const reviewOf = Effect.fn("ProjectFileActionApprovals.reviewOf")(function* (
    resolved: Effect.Success<ReturnType<typeof resolve>>,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => undefined));
    const approved =
      settings?.projectFileActionApprovals[resolved.key]?.[resolved.action.id] ?? null;
    return {
      actionId: resolved.action.id,
      name: resolved.action.name,
      command: resolved.action.command,
      roles: declaredFileActionRoles(resolved.action),
      approved,
      hint: yield* hintFor(resolved.action.command, resolved.project.workspaceRoot),
    } satisfies ProjectFileActionReview;
  });

  const review: ProjectFileActionApprovals["Service"]["review"] = (input) =>
    resolve(input).pipe(Effect.flatMap(reviewOf));

  const setApproved: ProjectFileActionApprovals["Service"]["setApproved"] = Effect.fn(
    "ProjectFileActionApprovals.setApproved",
  )(function* (input) {
    const resolved = yield* resolve(input);
    const roles = declaredFileActionRoles(resolved.action);
    if (input.approved && roles.length === 0) {
      return yield* fail("nothing-to-approve", "This action does not run on its own.");
    }
    const approvedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    // updateSettings replaces the whole map, so read it right before writing.
    yield* settingsService.getSettings.pipe(
      Effect.flatMap((settings) => {
        const { [resolved.action.id]: _previous, ...others } =
          settings.projectFileActionApprovals[resolved.key] ?? {};
        const entry = input.approved
          ? {
              ...others,
              [resolved.action.id]: { command: resolved.action.command, roles, approvedAt },
            }
          : others;
        const { [resolved.key]: _entry, ...repositories } = settings.projectFileActionApprovals;
        return settingsService.updateSettings({
          projectFileActionApprovals:
            Object.keys(entry).length === 0
              ? repositories
              : { ...repositories, [resolved.key]: entry },
        });
      }),
      Effect.mapError(() => fail("save-failed", "Could not save the settings.")),
    );
    yield* Effect.logInfo(
      input.approved ? "approved styal.json action" : "revoked styal.json action approval",
    ).pipe(
      Effect.annotateLogs({
        actor: "user",
        projectId: resolved.project.id,
        actionId: resolved.action.id,
        roles: roles.join(","),
      }),
    );
    return yield* reviewOf(resolved);
  });

  return ProjectFileActionApprovals.of({ automationConfig, review, setApproved });
});

export const layer = Layer.effect(ProjectFileActionApprovals, make);
