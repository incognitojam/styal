import { useGT, useMessages } from "gt-react-native";
import {
  nativeAppUpdateDownloader,
  useNativeAppUpdateDownload,
} from "../../updates/native-app-update-download";
import { formatApkSize, type NativeAppUpdate } from "../../updates/native-app-updates";
import { SettingsRow } from "./SettingsRow";

export function NativeAppUpdateRow({ update }: { readonly update: NativeAppUpdate }) {
  const gt = useGT();
  const m = useMessages();
  const state = useNativeAppUpdateDownload();
  // Keep an older download reachable if a newer release is found while it is running.
  if (state.status === "downloading") {
    return (
      <SettingsRow
        icon="xmark"
        label={gt("Downloading update")}
        disabled={false}
        value={gt("{percent}% · Tap to cancel", { percent: state.percent })}
        onPress={nativeAppUpdateDownloader.cancel}
      />
    );
  }
  if (state.status === "installing") {
    return (
      <SettingsRow
        icon="square.and.arrow.down"
        label={gt("Opening installer…")}
        value={gt("Confirm the update in Android")}
        disabled
      />
    );
  }
  const ready = state.status === "ready" && state.tag === update.tag;
  const failed = state.status === "error" && state.tag === update.tag;
  return (
    <SettingsRow
      icon="square.and.arrow.down"
      disabled={false}
      label={
        ready
          ? gt("Install styal {version}", { version: update.version })
          : failed
            ? gt("Retry update to styal {version}", { version: update.version })
            : gt("Update to styal {version}", { version: update.version })
      }
      value={
        ready
          ? state.message
            ? m(state.message)
            : gt("Download complete · Tap to install")
          : gt("{size} download", { size: formatApkSize(update.apkSizeBytes) })
      }
      onPress={() => void nativeAppUpdateDownloader.start(update)}
    />
  );
}
