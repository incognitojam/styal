export function isPendingNativeUpdateJob(output: string): boolean {
  return (
    /^\s*state = running\s*$/m.test(output) ||
    /^\s*pid = [1-9]\d*\s*$/m.test(output) ||
    !/^\s*state = (?:waiting|exited|not running)\s*$/m.test(output)
  );
}

export function isNativeUpdateJobMissing(error: unknown, label: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const output = ["stdout" in error ? error.stdout : "", "stderr" in error ? error.stderr : ""]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  if (/permission denied|operation not permitted|not privileged/i.test(output)) return false;
  // launchctl uses different exit codes across macOS releases; permission failures are not absence.
  return output
    .split("\n")
    .some((line) => line.trim().startsWith(`Could not find service "${label}" in domain `));
}
