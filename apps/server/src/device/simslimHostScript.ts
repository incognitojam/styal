const SIMSLIM_VERSION = "0.12.2";

/** Runs on the simulator host, including over SSH; inspecting never installs the helper. */
export const simslimHostScript = String.raw`
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const supported = process.platform === "darwin" && process.arch === "arm64";
const root = path.join(os.homedir(), ".cache", "styal", "simslim", "${SIMSLIM_VERSION}");
const executable = path.join(root, "simslim");
let installed = await fs.access(executable).then(() => true, () => false);
if (supported && !installed && process.argv[1] === "install") {
  await fs.mkdir(root, { recursive: true });
  const staging = await fs.mkdtemp(path.join(root, ".install-"));
  try {
    const response = await fetch("https://github.com/MobAI-App/simslim/releases/download/v${SIMSLIM_VERSION}/simslim-v${SIMSLIM_VERSION}-macos-arm64.tar.gz", { signal: AbortSignal.timeout(90000) });
    if (!response.ok) throw new Error("SimSlim download failed: " + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== "b47302da6fb83b8b4c21f4fdd61507469770c07b0ff07fd1f48207bda4270887") {
      throw new Error("SimSlim checksum mismatch");
    }
    const archive = path.join(staging, "release.tar.gz");
    await fs.writeFile(archive, bytes);
    execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", staging, "simslim"]);
    await fs.chmod(path.join(staging, "simslim"), 0o755);
    await fs.rename(path.join(staging, "simslim"), executable);
    installed = true;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ supported, installed, executable }));
`;
