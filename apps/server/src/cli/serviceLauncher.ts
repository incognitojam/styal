import { main as runServiceLauncher } from "../serviceLauncher.ts";

// The launcher and the server it spawns share this executable, so the host needs no Node.
export async function runServiceLauncherCli(): Promise<void> {
  try {
    await runServiceLauncher();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`[service-launcher] ${message}\n`);
    process.exitCode = 1;
  }
}
