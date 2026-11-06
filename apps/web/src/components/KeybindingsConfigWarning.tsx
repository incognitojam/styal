import type { EditorId, EnvironmentId } from "@t3tools/contracts";
import { OpenInPicker } from "./chat/OpenInPicker";

export function KeybindingsConfigWarning({
  message,
  environmentId,
  configPath,
  availableEditors,
}: {
  message: string;
  environmentId: EnvironmentId | null;
  configPath: string | null;
  availableEditors: readonly EditorId[];
}) {
  return (
    <>
      {message}
      <span className="mt-2 flex justify-end">
        {environmentId ? (
          <OpenInPicker
            environmentId={environmentId}
            keybindings={[]}
            availableEditors={availableEditors}
            openInCwd={configPath}
            openInCwdIsFile
            enableShortcut={false}
          />
        ) : null}
      </span>
    </>
  );
}
