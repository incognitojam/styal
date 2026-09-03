// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import {
  type LegacyImportPreferences,
  type LegacyImportPreferencesPreview,
  ServerSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeServerSettingsJson = Schema.decodeUnknownSync(Schema.fromJsonString(ServerSettings));

export function selectLegacyImportPreferences(settings: ServerSettings): LegacyImportPreferences {
  return {
    enableLegacyTokenStreaming: settings.enableLegacyTokenStreaming,
    enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
    enableAgentBrowserAccess: settings.enableAgentBrowserAccess,
    backgroundActivity: settings.backgroundActivity,
    automaticGitFetchInterval: settings.automaticGitFetchInterval,
    providerHealthRefreshInterval: settings.providerHealthRefreshInterval,
    backgroundActivityProfile: settings.backgroundActivityProfile,
    defaultThreadEnvMode: settings.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: settings.newWorktreesStartFromOrigin,
    addProjectBaseDirectory: settings.addProjectBaseDirectory,
    sourceControlWritingStyle: settings.sourceControlWritingStyle,
  };
}

export function readLegacyImportPreferences(settingsPath: string): LegacyImportPreferences {
  return selectLegacyImportPreferences(
    decodeServerSettingsJson(NodeFS.readFileSync(settingsPath, "utf8")),
  );
}

export function inspectLegacyImportPreferences(
  settingsPath: string,
): LegacyImportPreferencesPreview {
  if (!NodeFS.existsSync(settingsPath)) {
    return { status: "not-found" };
  }
  try {
    return { status: "available", values: readLegacyImportPreferences(settingsPath) };
  } catch {
    return { status: "unreadable" };
  }
}
