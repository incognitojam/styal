const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/;
const PREVIEW_VERSION_PATTERN = /-pr\./;

export function isNightlyDesktopVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version);
}

// Pull request preview builds, versioned `<base>-pr.<number>.<run>`.
export function isPreviewDesktopVersion(version: string): boolean {
  return PREVIEW_VERSION_PATTERN.test(version);
}
