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
      title="Move to styal.json"
      description={
        state === "failed"
          ? "Could not write styal.json. Check that the project folder is writable, then try again."
          : "This repository still uses a T3 Code t3.json, whose scripts styal only offers to import. Write a styal.json at the project root with its settings and scripts as shared actions, then commit it and delete t3.json. Actions that run on their own will ask for approval."
      }
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={!canWriteFiles || state === "writing"}
          onClick={() => void migrate()}
        >
          Write styal.json
        </Button>
      }
    />
  );
}
