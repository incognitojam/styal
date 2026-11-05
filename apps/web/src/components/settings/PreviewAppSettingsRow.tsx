import { useDesktopPreviewAppState } from "~/state/desktopPreviewApp";
import { previewAppActions as actions } from "../pullRequest/previewAppActions";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Settings → Pull request preview: the way back out once the pull request is closed or out of
 * sight. Hidden until a preview is installed or has left data behind.
 */
export function PreviewAppSettingsRow() {
  const state = useDesktopPreviewAppState();
  if (!state?.supported || (state.installed === null && !state.canReset)) return null;
  const busy = state.activity.status !== "idle";
  return (
    <SettingsRow
      {...searchableSetting("preview-app")}
      description={
        state.installed
          ? `styal (Preview) from pull request #${state.installed.pullRequestNumber}, build ${state.installed.runNumber}, is installed. It keeps its data when removed.`
          : "No preview is installed. Earlier previews left data behind."
      }
      control={
        <div className="flex items-center gap-2">
          {state.canOpen ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={actions.open}>
              Open
            </Button>
          ) : null}
          {state.canRemove ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={actions.remove}>
              Remove preview
            </Button>
          ) : null}
          {state.canReset ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={actions.resetData}>
              Reset preview data
            </Button>
          ) : null}
        </div>
      }
    />
  );
}
