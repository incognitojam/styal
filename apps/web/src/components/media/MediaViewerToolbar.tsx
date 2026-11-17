import { useState, type Ref } from "react";
import { CopyIcon, DownloadIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { useMediaActions, type MediaActionSource } from "./MediaActions";

export function MediaViewerToolbar({
  source,
  closeLabel,
  closeRef,
  onClose,
}: {
  readonly source: MediaActionSource;
  readonly closeLabel: string;
  readonly closeRef: Ref<HTMLButtonElement>;
  readonly onClose: () => void;
}) {
  const original = Boolean(source.originalAsset);
  const media = useMediaActions({
    ...source,
    ...(source.originalAsset ? { asset: source.originalAsset } : {}),
  });
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not complete media action",
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
    setBusy(false);
  };
  const open = () => {
    // Reserve the browser tab in the user gesture, before signing the original URL.
    const tab = window.desktopBridge ? null : window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    return run(() => {
      if (!window.desktopBridge && !tab)
        return Promise.reject(new Error("Allow pop-ups to open this image."));
      return media
        .actionUrl()
        .then(async (value) => {
          const url = new URL(value, window.location.href);
          if (!["http:", "https:", "blob:"].includes(url.protocol))
            return Promise.reject(
              new Error("Download this image instead; its URL cannot be opened in a browser."),
            );
          if (tab) tab.location.replace(url.href);
          else await readLocalApi()?.shell.openExternal(url.href);
        })
        .catch((error: unknown) => {
          tab?.close();
          return Promise.reject(error);
        });
    });
  };
  const actions = [
    {
      label: original ? "Download original" : "Download",
      icon: DownloadIcon,
      run: () => run(media.save),
    },
    ...(source.kind === "image" &&
    Boolean(navigator.clipboard?.write) &&
    typeof ClipboardItem !== "undefined"
      ? [{ label: "Copy image", icon: CopyIcon, run: () => run(media.copyImage) }]
      : []),
    { label: original ? "Open original" : "Open in browser", icon: ExternalLinkIcon, run: open },
  ];
  return (
    <div className="absolute right-0 top-0 z-20 flex items-center gap-3">
      <div
        role="toolbar"
        aria-label="Media actions"
        className="flex items-center gap-1 rounded-full bg-black/70 p-1 ring-1 ring-white/20"
      >
        {actions.map((action) => (
          <Tooltip key={action.label}>
            <TooltipTrigger
              render={<Button size="icon-sm-pill" variant="overlay" />}
              aria-label={action.label}
              disabled={busy || !media.canReadMedia}
              onClick={() => void action.run()}
            >
              <action.icon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">{action.label}</TooltipPopup>
          </Tooltip>
        ))}
      </div>
      <Button
        ref={closeRef}
        size="icon-sm-pill"
        variant="media-close"
        onClick={onClose}
        aria-label={closeLabel}
      >
        <XIcon />
      </Button>
    </div>
  );
}
