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
  /**
   * Directory below the styal home that becomes this install's own home, or
   * null to use the styal home itself. The desktop passes its home to the
   * local server, which keeps its state in `<home>/userdata`, so a separate
   * state directory alone would still leave the server on the shared database.
   */
  readonly homeDirName: string | null;
  /** Directory below the install's home that holds desktop state. */
  readonly stateDirName: string;
  readonly appUserModelId: string;
  readonly linuxDesktopEntryName: string;
}

export const DESKTOP_INSTALL_IDENTITIES: Record<DesktopInstallVariant, DesktopInstallIdentity> = {
  production: {
    slug: "styal",
    scheme: "styal",
    homeDirName: null,
    stateDirName: "userdata",
    appUserModelId: "build.styal.app",
    linuxDesktopEntryName: "build.styal.Styal.desktop",
  },
  preview: {
    slug: "styal-preview",
    scheme: "styal-preview",
    homeDirName: "preview",
    stateDirName: "userdata",
    appUserModelId: "build.styal.app.preview",
    linuxDesktopEntryName: "build.styal.Styal.Preview.desktop",
  },
  development: {
    slug: "styal-dev",
    scheme: "styal-dev",
    homeDirName: null,
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
