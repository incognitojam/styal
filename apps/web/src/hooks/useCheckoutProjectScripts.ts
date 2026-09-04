import { useAtomCommand } from "~/state/use-atom-command";
import { isElectron } from "~/env";
import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  setProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
} from "~/lib/projectScriptKeybindings";
import {
  legacyProjectScriptsForMigration,
  legacyT3ProjectScriptsForMigration,
  styalProjectFileContentsWithScripts,
} from "~/lib/styalProjectFileActions";
import { buildProjectScript, commandForProjectScript, nextProjectScriptId } from "~/projectScripts";
import { projectEnvironment } from "~/state/projects";
import { serverEnvironment } from "~/state/server";
import type { NewProjectScriptInput } from "~/components/projectScriptEditor";
import type {
  EnvironmentId,
  KeybindingCommand,
  ProjectScript,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo, useRef, useState } from "react";

import { useProjectFileState } from "./useProjectFileState";

interface CheckoutProjectScriptsInput {
  environmentId: EnvironmentId;
  cwd: string | null;
  savedScripts: ReadonlyArray<ProjectScript>;
  keybindings: ResolvedKeybindingsConfig;
}

export function useCheckoutProjectScripts(input: CheckoutProjectScriptsInput) {
  const projectFile = useProjectFileState(input.environmentId, input.cwd);
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const { legacyFile, liveScripts, refresh, source, status, styalContents } = projectFile;

  const legacyScripts = useMemo(
    () =>
      legacyProjectScriptsForMigration({
        liveScripts,
        legacyFile,
        savedScripts: input.savedScripts,
      }),
    [input.savedScripts, legacyFile, liveScripts],
  );

  const writeScripts = useCallback(
    async (scripts: ReadonlyArray<ProjectScript>): Promise<AtomCommandResult<void, unknown>> => {
      if (input.cwd === null) return AsyncResult.success(undefined);
      if (status === "loading") {
        return AsyncResult.failure<void, Error>(
          Cause.fail(new Error("Wait for the project file to finish loading.")),
        );
      }
      if (status === "invalid" && source === "styal.json") {
        return AsyncResult.failure<void, Error>(
          Cause.fail(new Error("Fix the invalid styal.json before changing actions.")),
        );
      }
      if (savingRef.current) {
        return AsyncResult.failure<void, Error>(
          Cause.fail(new Error("Another action change is still saving. Try again.")),
        );
      }

      savingRef.current = true;
      setIsSaving(true);
      const contents = styalProjectFileContentsWithScripts({
        currentContents: styalContents,
        legacyFile,
        scripts,
      });
      setProjectFileQueryData(input.environmentId, input.cwd, "styal.json", contents);
      try {
        const result = mapAtomCommandResult(
          await writeFile({
            environmentId: input.environmentId,
            input: { cwd: input.cwd, relativePath: "styal.json", contents },
          }),
          () => undefined,
        );
        if (result._tag === "Success") {
          confirmProjectFileQueryData(input.environmentId, input.cwd, "styal.json", contents);
          refresh();
        } else {
          clearProjectFileQueryData(input.environmentId, input.cwd, "styal.json");
        }
        return result;
      } finally {
        savingRef.current = false;
        setIsSaving(false);
      }
    },
    [input.cwd, input.environmentId, legacyFile, refresh, source, status, styalContents, writeFile],
  );

  const persistKeybinding = useCallback(
    async (
      command: KeybindingCommand,
      keybinding: string | null,
    ): Promise<AtomCommandResult<void, unknown>> => {
      if (!isElectron) return AsyncResult.success(undefined);
      const previousKey = keybindingValueForCommand(input.keybindings, command);
      const previousRule = previousKey
        ? decodeProjectScriptKeybindingRule({ keybinding: previousKey, command })
        : null;
      const nextRule = decodeProjectScriptKeybindingRule({ keybinding, command });
      if (nextRule) {
        const next =
          previousRule && previousRule.key !== nextRule.key
            ? { ...nextRule, replace: previousRule }
            : nextRule;
        return mapAtomCommandResult(
          await upsertKeybinding({ environmentId: input.environmentId, input: next }),
          () => undefined,
        );
      }
      if (previousRule) {
        return mapAtomCommandResult(
          await removeKeybinding({ environmentId: input.environmentId, input: previousRule }),
          () => undefined,
        );
      }
      return AsyncResult.success(undefined);
    },
    [input.environmentId, input.keybindings, removeKeybinding, upsertKeybinding],
  );

  const persistScripts = useCallback(
    async (
      scripts: ReadonlyArray<ProjectScript>,
      command: KeybindingCommand,
      keybinding: string | null,
    ) => {
      const writeResult = await writeScripts(scripts);
      if (writeResult._tag === "Failure") return writeResult;
      return persistKeybinding(command, keybinding);
    },
    [persistKeybinding, writeScripts],
  );

  const addScript = useCallback(
    async (scriptInput: NewProjectScriptInput) => {
      // Creating styal.json also carries forward t3.json actions, since the
      // legacy file stops being consulted as soon as the new file exists.
      const t3Scripts = legacyT3ProjectScriptsForMigration({
        liveScripts,
        legacyFile,
        savedScripts: input.savedScripts,
      });
      const baseScripts = [...liveScripts, ...t3Scripts];
      const id = nextProjectScriptId(
        scriptInput.name,
        [...liveScripts, ...legacyScripts].map((script) => script.id),
      );
      const nextScript = buildProjectScript(id, scriptInput);
      const nextScripts = scriptInput.runOnWorktreeCreate
        ? [
            ...baseScripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...baseScripts, nextScript];
      return persistScripts(nextScripts, commandForProjectScript(id), scriptInput.keybinding);
    },
    [input.savedScripts, legacyFile, legacyScripts, liveScripts, persistScripts],
  );

  const updateScript = useCallback(
    async (scriptId: string, scriptInput: NewProjectScriptInput) => {
      if (!liveScripts.some((script) => script.id === scriptId)) {
        return AsyncResult.failure<void, Error>(
          Cause.fail(new Error("Action not found in styal.json.")),
        );
      }
      const nextScripts = liveScripts.map((script) =>
        script.id === scriptId
          ? buildProjectScript(scriptId, scriptInput)
          : scriptInput.runOnWorktreeCreate && script.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );
      return persistScripts(nextScripts, commandForProjectScript(scriptId), scriptInput.keybinding);
    },
    [liveScripts, persistScripts],
  );

  const deleteScript = useCallback(
    async (scriptId: string) =>
      persistScripts(
        liveScripts.filter((script) => script.id !== scriptId),
        commandForProjectScript(scriptId),
        null,
      ),
    [liveScripts, persistScripts],
  );

  const migrateLegacyScripts = useCallback(
    () => writeScripts([...liveScripts, ...legacyScripts]),
    [legacyScripts, liveScripts, writeScripts],
  );
  const hasLegacyConfig =
    status !== "loading" &&
    status !== "invalid" &&
    (legacyFile !== null || legacyScripts.length > 0);
  const canEdit = status !== "loading" && !(status === "invalid" && source === "styal.json");

  return useMemo(
    () => ({
      projectFile,
      scripts: liveScripts,
      legacyScripts,
      hasLegacyConfig,
      canEdit,
      isSaving,
      addScript,
      updateScript,
      deleteScript,
      migrateLegacyScripts,
    }),
    [
      addScript,
      canEdit,
      deleteScript,
      hasLegacyConfig,
      isSaving,
      legacyScripts,
      liveScripts,
      migrateLegacyScripts,
      projectFile,
      updateScript,
    ],
  );
}
