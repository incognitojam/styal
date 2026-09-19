// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { parse } from "yaml";
import { checkCliReleaseFreshness } from "./check-cli-release-freshness.ts";

// Fresh CI checkouts do not inherit a developer's local Git excludes.
function prepareScratch(root: string) {
  const ignored = NodeChildProcess.spawnSync("git", ["check-ignore", "-q", ".scratch/"], {
    cwd: root,
  });
  if (ignored.status === 1) {
    const exclude = NodeChildProcess.execFileSync(
      "git",
      ["rev-parse", "--git-path", "info/exclude"],
      {
        cwd: root,
        encoding: "utf8",
      },
    ).trim();
    const excludePath = NodePath.resolve(root, exclude);
    NodeFS.mkdirSync(NodePath.dirname(excludePath), { recursive: true });
    NodeFS.appendFileSync(excludePath, "\n.scratch/\n");
  } else if (ignored.status !== 0) {
    throw new Error("Could not check Git scratch exclusion");
  }
  NodeFS.mkdirSync(NodePath.resolve(root, ".scratch"), { recursive: true });
}

describe("CLI release freshness", () => {
  it.each([
    ["1.2.9", "1.2.10", "latest"],
    ["1.2.3-nightly.20260918.99", "1.2.3-nightly.20260919.100", "nightly"],
    ["1.2.3-nightly.20260919.9", "1.2.3-nightly.20260919.10", "nightly"],
  ])("rejects %s behind %s", async (version, current, tag) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ "dist-tags": { [tag]: current } }));
    await expect(checkCliReleaseFreshness(version, tag, request)).rejects.toThrow("Stale release");
  });

  it.each(["1.2.9", "1.2.10"])("accepts current/forward retry against %s", async (current) => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ "dist-tags": { latest: current } }));
    await checkCliReleaseFreshness("1.2.10", "latest", request);
    expect(request).toHaveBeenCalledTimes(6);
  });

  it("checks platform tags even when the launcher is missing", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ "dist-tags": { nightly: "1.2.3-nightly.20260919.100" } }),
      );
    await expect(
      checkCliReleaseFreshness("1.2.3-nightly.20260918.99", "nightly", request),
    ).rejects.toThrow("@styal/cli-darwin-arm64");
  });

  it("allows first publication and a missing channel tag", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockImplementation(async () => Response.json({ "dist-tags": { latest: "1.2.2" } }));
    await checkCliReleaseFreshness("1.2.3-nightly.20260919.100", "nightly", request);
    expect(request).toHaveBeenCalledTimes(6);
  });

  it.each([
    new Response(null, { status: 503 }),
    Response.json({}),
    Response.json({ "dist-tags": { latest: "garbage" } }),
    new Response("invalid json"),
  ])("fails closed on registry errors", async (response) => {
    await expect(
      checkCliReleaseFreshness(
        "1.2.3",
        "latest",
        vi.fn<typeof fetch>().mockResolvedValue(response),
      ),
    ).rejects.toThrow();
  });

  it("propagates network failures", async () => {
    await expect(
      checkCliReleaseFreshness(
        "1.2.3",
        "latest",
        vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
      ),
    ).rejects.toThrow("offline");
  });
});

it("nightly promotion allows forward/equal pushes and rejects a stale release-only retry", () => {
  const root = NodePath.resolve(import.meta.dirname, "..");
  prepareScratch(root);
  const directory = NodeFS.mkdtempSync(NodePath.resolve(root, ".scratch/release-freshness-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "--bare", "remote.git");
    git("init");
    git("config", "user.name", "Release Test");
    git("config", "user.email", "release@example.invalid");
    git("remote", "add", "origin", NodePath.resolve(directory, "remote.git"));
    git("commit", "--allow-empty", "-m", "older");
    const older = git("rev-parse", "HEAD");
    const workflow = parse(
      NodeFS.readFileSync(NodePath.resolve(root, ".github/workflows/fork-nightly.yml"), "utf8"),
    );
    const command = workflow.jobs.release.steps.find(
      (step: { name?: string }) => step.name === "Promote successful nightly source",
    ).run;
    const promote = () =>
      NodeChildProcess.spawnSync("bash", ["-e", "-c", command], {
        cwd: directory,
        encoding: "utf8",
      });
    expect(promote().status).toBe(0);
    git("commit", "--allow-empty", "-m", "newer");
    const newer = git("rev-parse", "HEAD");
    expect(promote().status).toBe(0);
    expect(promote().status).toBe(0);
    git("checkout", "--detach", older);
    expect(promote().status).not.toBe(0);
    expect(git("--git-dir=remote.git", "rev-parse", "refs/heads/nightly")).toBe(newer);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

// Run the workflow's real retry function with registry responses supplied by a
// shell npm stub, so these cases cannot publish or change public package tags.
describe.each([
  ["latest", "1.2.3", "1.2.2"],
  ["nightly", "1.2.3-nightly.20260919.100", "1.2.3-nightly.20260918.99"],
])("verified %s publication retries", (tag, version, older) => {
  it.each([
    "matching",
    "older",
    "missing",
    "registry-error",
    "invalid-json",
    "wrong-bytes",
    "unpublished",
  ])("%s registry state", (scenario) => {
    const root = NodePath.resolve(import.meta.dirname, "..");
    prepareScratch(root);
    const directory = NodeFS.mkdtempSync(NodePath.resolve(root, ".scratch/release-retry-"));
    try {
      NodeFS.writeFileSync(NodePath.join(directory, "archive.tgz"), "synthetic release bytes");
      const workflow = parse(
        NodeFS.readFileSync(NodePath.join(root, ".github/workflows/fork-cli-build.yml"), "utf8"),
      );
      const command: string = workflow.jobs.publish.steps.find(
        (step: { name?: string }) => step.name === "Publish verified archive",
      ).run;
      const retryFunction = command.slice(
        command.indexOf("publish_or_verify()"),
        command.indexOf("# Publish all five"),
      );
      const result = NodeChildProcess.spawnSync(
        "bash",
        [
          "-c",
          `
set -euo pipefail
integrity="sha512-$(openssl dgst -sha512 -binary archive.tgz | openssl base64 -A)"
npm() {
  if [[ "$1" == publish ]]; then
    echo published >> calls
    return 0
  fi
  if [[ "$3" == dist.integrity ]]; then
    if [[ "$SCENARIO" == unpublished ]]; then
      echo E404 >&2
      return 1
    fi
    if [[ "$SCENARIO" == wrong-bytes ]]; then
      echo '"sha512-wrong"'
    else
      printf '"%s"\\n' "$integrity"
    fi
    return 0
  fi
  if [[ "$SCENARIO" == registry-error ]]; then
    echo registry-unavailable >&2
    return 1
  fi
  printf '%s\\n' "$TAGS_JSON"
}
${retryFunction}
publish_or_verify @styal/cli ./archive.tgz
`,
        ],
        {
          cwd: directory,
          encoding: "utf8",
          env: {
            ...process.env,
            RELEASE_VERSION: version,
            DIST_TAG: tag,
            SCENARIO: scenario,
            TAGS_JSON:
              scenario === "invalid-json"
                ? "invalid json"
                : JSON.stringify(
                    scenario === "missing" ? {} : { [tag]: scenario === "older" ? older : version },
                  ),
          },
        },
      );
      if (scenario === "matching" || scenario === "unpublished") {
        expect(result.status, result.stderr).toBe(0);
      } else {
        expect(result.status).not.toBe(0);
      }
      if (scenario === "older" || scenario === "missing") {
        expect(result.stderr).toContain("Repair the channel tag before retrying");
      }
      expect(NodeFS.existsSync(NodePath.join(directory, "calls"))).toBe(scenario === "unpublished");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
