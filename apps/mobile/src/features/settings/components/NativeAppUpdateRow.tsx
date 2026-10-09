import {
  nativeAppUpdateDownloader,
  useNativeAppUpdateDownload,
} from "../../updates/native-app-update-download";
import { formatApkSize, type NativeAppUpdate } from "../../updates/native-app-updates";
import { SettingsRow } from "./SettingsRow";

export function NativeAppUpdateRow({ update }: { readonly update: NativeAppUpdate }) {
  const state = useNativeAppUpdateDownload();
  // Keep an older download reachable if a newer release is found while it is running.
  if (state.status === "downloading") {
    return (
      <SettingsRow
        icon="xmark"
        label="Downloading update"
        disabled={false}
        value={`${state.percent}% · Tap to cancel`}
        onPress={nativeAppUpdateDownloader.cancel}
      />
    );
  }
  if (state.status === "installing") {
    return (
      <SettingsRow
        icon="square.and.arrow.down"
        label="Opening installer…"
        value="Confirm the update in Android"
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
      label={`${ready ? "Install" : failed ? "Retry update to" : "Update to"} styal ${update.version}`}
      value={
        ready
          ? (state.message ?? "Download complete · Tap to install")
          : `${formatApkSize(update.apkSizeBytes)} download`
      }
      onPress={() => void nativeAppUpdateDownloader.start(update)}
    />
  );
}
