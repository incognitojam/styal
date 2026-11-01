import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { build } from "vite-plus";
import { isDesktopRuntimeExternalDependency } from "../../../scripts/lib/desktop-external-packages.ts";
import { resolveElectronBinaryPath } from "./electron-launcher.mjs";

const desktopDir = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const repoRoot = NodePath.resolve(desktopDir, "../..");
const outputDir = NodePath.join(repoRoot, ".scratch", "preview-calibration");
const require = NodeModule.createRequire(NodePath.join(desktopDir, "package.json"));
const ignored = NodeChildProcess.spawnSync("git", ["check-ignore", "-q", ".scratch/"], {
  cwd: repoRoot,
});
if (ignored.status !== 0)
  throw new Error("Ignore .scratch/ in .git/info/exclude before running calibration");
await NodeFSP.rm(outputDir, { recursive: true, force: true });
await NodeFSP.mkdir(NodePath.join(outputDir, "state"), { recursive: true });
await build({
  configFile: false,
  plugins: [
    {
      name: "preview-calibration-runtime",
      resolveId(id) {
        if (id.startsWith("effect/")) return require.resolve(id);
      },
    },
  ],
  build: {
    target: "node24",
    outDir: NodePath.join(outputDir, "bundle"),
    lib: {
      entry: NodePath.join(desktopDir, "scripts/preview-calibration/main.mjs"),
      formats: ["cjs"],
      fileName: () => "main.cjs",
    },
    // The same externals as the desktop main process build, such as native passkey support.
    rollupOptions: {
      external: (id) =>
        id === "electron" || id.startsWith("node:") || isDesktopRuntimeExternalDependency(id),
    },
  },
});
// Use the unbranded runtime: calibration must not register the app's URL schemes.
const electronPath = resolveElectronBinaryPath();
const platform = await Effect.runPromise(HostProcess.Platform);
const args = [NodePath.join(outputDir, "bundle/main.cjs"), `--calibration-output=${outputDir}`];
if (platform === "linux") args.unshift("--no-sandbox");
const environment = { ...NodeProcess.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = NodeChildProcess.spawn(electronPath, args, {
  cwd: repoRoot,
  env: environment,
  stdio: "inherit",
});
const timeout = setTimeout(() => {
  console.error("Preview calibration exceeded 90 seconds");
  child.kill();
}, 90_000);
child.once("error", (error) => {
  clearTimeout(timeout);
  console.error(error);
  NodeProcess.exit(1);
});
child.once("exit", async (code, signal) => {
  clearTimeout(timeout);
  if (signal !== null || code !== 0) NodeProcess.exit(1);
  try {
    const measurements = JSON.parse(
      await NodeFSP.readFile(NodePath.join(outputDir, "measurements.json"), "utf8"),
    );
    if (
      measurements.length !== 13 ||
      measurements.some((entry) => entry.name !== "natural-size" && !entry.agentCapture)
    )
      throw new Error("Calibration did not complete all 13 scenarios");
  } catch (error) {
    console.error(error);
    NodeProcess.exit(1);
  }
});
