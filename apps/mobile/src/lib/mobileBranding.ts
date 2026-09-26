export type MobileStageLabel = "Dev" | "Preview";

// Production builds show no stage label; the others name their build.
export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel | null {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Preview";
  return null;
}
