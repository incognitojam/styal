import {
  ProjectReadFileError,
  type ProjectReadFileResult,
  type ProjectScript,
} from "@t3tools/contracts";
import { projectScriptsFromStyalFile } from "@t3tools/shared/projectScripts";
import { parseStyalProjectFile } from "@t3tools/shared/styalProjectFile";
import * as Schema from "effect/Schema";

const isProjectReadFileError = Schema.is(ProjectReadFileError);
const NO_PROJECT_SCRIPTS: ReadonlyArray<ProjectScript> = [];

export function resolveMobileProjectScripts(input: {
  readonly fileData: ProjectReadFileResult | null;
  readonly fileFailure: unknown | null;
  readonly localScripts: ReadonlyArray<ProjectScript>;
}): ReadonlyArray<ProjectScript> {
  if (input.fileData === null) {
    return isProjectReadFileError(input.fileFailure) && input.fileFailure.failure === "not_found"
      ? input.localScripts
      : NO_PROJECT_SCRIPTS;
  }
  if (input.fileData.truncated) return NO_PROJECT_SCRIPTS;
  const file = parseStyalProjectFile(input.fileData.contents);
  return file === null ? NO_PROJECT_SCRIPTS : projectScriptsFromStyalFile(file.scripts ?? []);
}
