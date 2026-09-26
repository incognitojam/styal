import { isPreviewDesktopVersion } from "../updates/updateChannels.ts";

/**
 * Which side-by-side install a build belongs to. Stable and nightly are one
 * install that switches update track, so they share state. Pull request
 * previews and development builds each have their own identity and state, so
 * they run beside that install without reading or migrating its database.
 */
export type DesktopInstallVariant = "production" | "preview" | "development";

export interface DesktopInstallIdentity {
  /** Electron app name, user-data directory name, and Linux WM class. */
  readonly slug: string;
  readonly scheme: string;
  /** Directory below the base directory that holds server and desktop state. */
  readonly stateDirName: string;
  readonly appUserModelId: string;
  readonly linuxDesktopEntryName: string;
}

export const DESKTOP_INSTALL_IDENTITIES: Record<DesktopInstallVariant, DesktopInstallIdentity> = {
  production: {
    slug: "styal",
    scheme: "styal",
    stateDirName: "userdata",
    appUserModelId: "build.styal.app",
    linuxDesktopEntryName: "build.styal.Styal.desktop",
  },
  preview: {
    slug: "styal-preview",
    scheme: "styal-preview",
    stateDirName: "preview",
    appUserModelId: "build.styal.app.preview",
    linuxDesktopEntryName: "build.styal.Styal.Preview.desktop",
  },
  development: {
    slug: "styal-dev",
    scheme: "styal-dev",
    stateDirName: "dev",
    appUserModelId: "build.styal.app.dev",
    linuxDesktopEntryName: "build.styal.Styal.Development.desktop",
  },
};

export function resolveDesktopInstallVariant(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
}): DesktopInstallVariant {
  if (input.isDevelopment) return "development";
  return isPreviewDesktopVersion(input.appVersion) ? "preview" : "production";
}
