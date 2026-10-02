// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import {
  type LegacyImportPreferences,
  type LegacyImportPreferencesPreview,
  ServerSettings,
  ResponseStreamingMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decodeLegacySettingsJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      ...ServerSettings.fields,
      responseStreamingMode: Schema.Union([ResponseStreamingMode, Schema.Literal("token")]).pipe(
        Schema.withDecodingDefault(Effect.succeed("paragraph" as const)),
      ),
    }),
  ),
);
const decodeServerSettingsJson = (raw: string): ServerSettings => {
  const settings = decodeLegacySettingsJson(raw);
  return {
    ...settings,
    responseStreamingMode:
      settings.responseStreamingMode === "token" ? "paragraph" : settings.responseStreamingMode,
  };
};

function selectLegacyImportPreferences(settings: ServerSettings): LegacyImportPreferences {
  return {
    responseStreamingMode: settings.responseStreamingMode,
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
