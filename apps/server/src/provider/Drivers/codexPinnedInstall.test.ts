// @effect-diagnostics nodeBuiltinImport:off - runs the generated shell script against a stub curl.
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import {
  CODEX_INSTALL_SCRIPT_URL,
  codexSelfUpdaterActive,
  makeCodexPinnedInstall,
} from "./codexPinnedInstall.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

// Stands in for curl: records the URL and saves an installer that records how it ran.
const FAKE_CURL = `#!/bin/sh
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
[ -n "\${FAIL_DOWNLOAD:-}" ] && exit 22
printf '%s\\n' "$url" > "$LOG.url"
cat > "$out" <<'SCRIPT'
printf 'args=%s\\n' "$*" > "$LOG"
printf 'home=%s\\ndir=%s\\nnoninteractive=%s\\nguard=%s\\n' "$CODEX_HOME" "$CODEX_INSTALL_DIR" "$CODEX_NON_INTERACTIVE" "\${CODEX_INSTALL_IF_CURRENT:-}" >> "$LOG"
SCRIPT
`;

describe("makeCodexPinnedInstall", () => {
  it.skipIf(windowsHost)(
    "downloads the install script and runs it for exactly the requested release",
    () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "styal-codex-pinned-"));
      try {
        const fakeBin = NodePath.join(root, "fake-bin");
        const scratch = NodePath.join(root, "tmp");
        NodeFS.mkdirSync(fakeBin);
        NodeFS.mkdirSync(scratch);
        NodeFS.writeFileSync(NodePath.join(fakeBin, "curl"), FAKE_CURL, { mode: 0o755 });
        const log = NodePath.join(root, "install.log");
        const visibleDir = NodePath.join(root, "home", ".local", "bin");
        const codexHome = NodePath.join(root, "home", ".codex");
        const action = makeCodexPinnedInstall(codexHome)("0.163.0", {
          resolvedCommandPath: NodePath.join(visibleDir, "codex"),
          env: { PATH: `${fakeBin}:/usr/bin:/bin` },
        });
        expect(action.command).toBe(
          `curl -fsSL ${CODEX_INSTALL_SCRIPT_URL} | sh -s -- --release 0.163.0`,
        );
        const run = (extra: NodeJS.ProcessEnv) =>
          NodeChildProcess.spawnSync(action.executable, action.args, {
            env: { ...action.env, LOG: log, TMPDIR: scratch, ...extra },
            encoding: "utf8",
          });

        const installed = run({});
        expect(installed.status).toBe(0);
        expect(NodeFS.readFileSync(`${log}.url`, "utf8").trim()).toBe(CODEX_INSTALL_SCRIPT_URL);
        expect(NodeFS.readFileSync(log, "utf8").split("\n")).toEqual([
          "args=--release 0.163.0",
          `home=${codexHome}`,
          `dir=${visibleDir}`,
          "noninteractive=1",
          // The script's compare-and-swap guard refuses any pinned release.
          "guard=",
          "",
        ]);
        // The downloaded script is removed once it ran.
        expect(NodeFS.readdirSync(scratch)).toEqual([]);

        NodeFS.rmSync(log);
        const failed = run({ FAIL_DOWNLOAD: "1" });
        expect(failed.status).not.toBe(0);
        expect(NodeFS.existsSync(log)).toBe(false);
        expect(NodeFS.readdirSync(scratch)).toEqual([]);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("leaves the install directory to the script when codex runs from the standalone tree", () => {
    const action = makeCodexPinnedInstall("/home/developer/.codex")("0.163.0", {
      resolvedCommandPath: "/home/developer/.codex/packages/standalone/current/bin/codex",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(action.env).toEqual({
      CODEX_HOME: "/home/developer/.codex",
      CODEX_NON_INTERACTIVE: "1",
    });
  });
});

describe("codexSelfUpdaterActive", () => {
  it.skipIf(windowsHost)(
    "is active only while the self-update marker names the selected release",
    async () => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "styal-codex-marker-"));
      const check = () =>
        codexSelfUpdaterActive(home).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
      try {
        const standalone = NodePath.join(home, "packages", "standalone");
        const release = "0.162.1-aarch64-apple-darwin";
        const marker = NodePath.join(standalone, "auto-update-version");
        // No standalone tree, or one installed with `--release`: no marker.
        expect(await check()).toBe(false);
        NodeFS.mkdirSync(NodePath.join(standalone, "releases", release), { recursive: true });
        NodeFS.symlinkSync(
          NodePath.join(standalone, "releases", release),
          NodePath.join(standalone, "current"),
        );
        expect(await check()).toBe(false);
        // A latest-channel install writes the release name without a newline.
        NodeFS.writeFileSync(marker, release);
        expect(await check()).toBe(true);
        // A marker left from another release does not keep the updater on.
        NodeFS.writeFileSync(marker, "0.161.0-aarch64-apple-darwin");
        expect(await check()).toBe(false);
        // The selection cannot be read: unknown.
        NodeFS.rmSync(NodePath.join(standalone, "current"));
        expect(await check()).toBe(null);
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
