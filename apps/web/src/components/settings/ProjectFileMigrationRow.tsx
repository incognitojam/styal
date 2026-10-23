import {
  AuthFilesystemWriteScope,
  STYAL_PROJECT_FILE_NAME,
  type EnvironmentId,
} from "@t3tools/contracts";
import { styalProjectFileFromT3 } from "@t3tools/shared/projectFile";
import { useState } from "react";

import { projectEnvironment } from "~/state/projects";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { appAtomRegistry } from "~/rpc/atomRegistry";

import { getProjectFileQueryAtom } from "../files/projectFilesQueryState";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

/**
 * Offers to write a styal.json from the project's legacy t3.json, at the
 * project root. The t3.json stays until the user removes it; once a
 * styal.json exists, it is ignored.
 */
export function ProjectFileMigrationRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectRoot: string;
  /** Names the checkout written to when the project spans several environments. */
  readonly environmentLabel: string | null;
  readonly legacyContents: string;
}) {
  const canWriteFiles = useEnvironmentScope(props.environmentId, AuthFilesystemWriteScope);
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const [state, setState] = useState<"idle" | "writing" | "failed">("idle");
  const contents = styalProjectFileFromT3(props.legacyContents);
  if (contents === null) return null;

  const migrate = async () => {
    setState("writing");
    const result = await writeFile({
      environmentId: props.environmentId,
      input: { cwd: props.projectRoot, relativePath: STYAL_PROJECT_FILE_NAME, contents },
    });
    if (result._tag === "Failure") {
      setState("failed");
      return;
    }
    // Read the new file back so the project switches to it straight away.
    appAtomRegistry.refresh(
      getProjectFileQueryAtom(props.environmentId, props.projectRoot, STYAL_PROJECT_FILE_NAME),
    );
    setState("idle");
  };

  return (
    <SettingsRow
      title="Create styal.json from t3.json"
      description={
        state === "failed"
          ? "Could not write styal.json. Check that the project folder is writable, then try again."
          : `Writes styal.json to ${props.projectRoot}${props.environmentLabel ? ` on ${props.environmentLabel}` : ""} with t3.json's settings, and turns its scripts into shared actions. Nothing is committed: review the file, commit it, then delete t3.json. Actions that run automatically need your approval first.`
      }
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={!canWriteFiles || state === "writing"}
          onClick={() => void migrate()}
        >
          Create styal.json
        </Button>
      }
    />
  );
}
