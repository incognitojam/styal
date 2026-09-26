import * as Option from "effect/Option";

import { DESKTOP_INSTALL_IDENTITIES, type DesktopInstallVariant } from "./DesktopInstallVariant.ts";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(t3Home: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(t3Home)) {
    return Option.none();
  }
  const trimmed = t3Home.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.t3Home), () =>
    input.joinPath(input.homeDirectory, ".styal"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly variant: DesktopInstallVariant;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  // An explicit home already isolates a development build, so its state uses
  // that home's usual userdata directory.
  const variant =
    input.variant === "development" && Option.isSome(normalizeConfiguredBaseDir(input.t3Home))
      ? "production"
      : input.variant;
  return input.joinPath(input.baseDir, DESKTOP_INSTALL_IDENTITIES[variant].stateDirName);
}
