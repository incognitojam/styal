import { ChevronDownIcon, XIcon } from "lucide-react";

import { RelativeTime } from "~/components/RelativeTime";
import {
  getDesktopPreviewAppBridge,
  useDesktopPreviewAppBuild,
  useDesktopPreviewAppState,
} from "~/state/desktopPreviewApp";
import type { PullRequestDetail } from "@t3tools/contracts";
import { formatBytes } from "../../lib/formatBytes";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { previewAppActions as actions } from "./previewAppActions";
import {
  previewAppControlView,
  previewBuildIsRunning,
  pullRequestCanHavePreviewApp,
} from "./pullRequestPreviewApp.logic";

/** Offers this pull request's unsigned macOS build where the desktop app can install it. */
export function PullRequestPreviewAppControl({
  detail,
  repository,
}: {
  readonly detail: PullRequestDetail;
  readonly repository: string;
}) {
  const state = useDesktopPreviewAppState();
  const available =
    getDesktopPreviewAppBridge() !== undefined &&
    state?.supported === true &&
    pullRequestCanHavePreviewApp(detail, repository);
  const buildRunning = previewBuildIsRunning(detail);
  const { build, lookupFailed } = useDesktopPreviewAppBuild(
    available ? detail.number : null,
    `${detail.headSha ?? ""}:${buildRunning}`,
  );
  if (!available) return null;

  const view = previewAppControlView({
    pullRequestNumber: detail.number,
    state,
    build,
    buildRunning,
    lookupFailed,
  });
  if (view.kind === "hidden") return null;

  if (view.kind === "busy") {
    return (
      <>
        <Button size="xs" variant="outline" disabled>
          <span className="tabular-nums">{view.label}</span>
        </Button>
        {view.canCancel ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Cancel preview install"
                  size="icon-xs"
                  variant="ghost-muted"
                  onClick={actions.cancelInstall}
                />
              }
            >
              <XIcon />
            </TooltipTrigger>
            <TooltipPopup>Cancel</TooltipPopup>
          </Tooltip>
        ) : null}
      </>
    );
  }

  if (view.kind === "building") {
    return (
      <Button size="xs" variant="outline" disabled>
        Building preview…
      </Button>
    );
  }

  if (view.kind === "lookup-failed") {
    return (
      <Button size="xs" variant="outline" disabled>
        Can't check for a preview
      </Button>
    );
  }

  const manageable = state?.canRemove === true || state?.canReset === true;
  return (
    <>
      {view.kind === "install" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button size="xs" variant="outline" onClick={() => actions.install(detail.number)} />
            }
          >
            {view.label}
          </TooltipTrigger>
          <TooltipPopup className="max-w-72">
            <div>
              Unsigned build {view.build.runNumber}, {formatBytes(view.build.sizeBytes)}, published{" "}
              <RelativeTime timestamp={view.build.publishedAt} />.
            </div>
            {view.replaces ? (
              <div>
                Replaces #{view.replaces.pullRequestNumber}, build {view.replaces.runNumber}.
              </div>
            ) : null}
            {view.newerBuildRunning ? <div>A newer build is running.</div> : null}
          </TooltipPopup>
        </Tooltip>
      ) : (
        <Button size="xs" variant="outline" disabled={!view.canOpen} onClick={actions.open}>
          {view.canOpen ? "Open preview" : "Preview installed"}
        </Button>
      )}
      {manageable ? (
        <Menu>
          <MenuTrigger
            render={<Button aria-label="Manage preview" size="icon-xs" variant="ghost-muted" />}
          >
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem disabled={!state?.canRemove} onClick={actions.remove}>
              Remove preview
            </MenuItem>
            <MenuItem disabled={!state?.canReset} onClick={actions.resetData}>
              Reset preview data…
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );
}
