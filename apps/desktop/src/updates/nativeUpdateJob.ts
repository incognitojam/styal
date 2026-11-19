export function isPendingNativeUpdateJob(output: string): boolean {
  return (
    /^\s*state = running\s*$/m.test(output) ||
    /^\s*pid = [1-9]\d*\s*$/m.test(output) ||
    !/^\s*state = (?:waiting|exited|not running)\s*$/m.test(output)
  );
}

export function isNativeUpdateJobMissing(error: unknown, label: string): boolean {
  if (typeof error !== "object" || error === null || !("stderr" in error)) return false;
  if (typeof error.stderr !== "string") return false;
  if (/permission denied|operation not permitted|not privileged/i.test(error.stderr)) return false;
  // launchctl uses different exit codes across macOS releases; permission failures are not absence.
  return error.stderr
    .split("\n")
    .some((line) => line.trim().startsWith(`Could not find service "${label}" in domain `));
}
