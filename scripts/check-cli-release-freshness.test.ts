// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import { parse } from "yaml";
import { checkCliReleaseFreshness } from "./check-cli-release-freshness.ts";

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

const workflow = parse(
  NodeFS.readFileSync(new URL("../.github/workflows/fork-cli-build.yml", import.meta.url), "utf8"),
);
const publishCommand: string = workflow.jobs.publish.steps.find(
  (step: { name?: string }) => step.name === "Publish verified archive",
).run;

it.each([
  ["latest", "matching"],
  ["nightly", "matching"],
  ["latest", "older"],
  ["nightly", "missing"],
  ["latest", "wrong-bytes"],
  ["nightly", "registry-error"],
  ["latest", "unpublished"],
])("publishes %s with %s registry state", (tag, scenario) => {
  const version = tag === "latest" ? "1.2.3" : "1.2.3-nightly.20260919.100";
  // Exercise the whole shell step without files or network calls. Freshness is
  // tested above; fixed digests isolate the integrity and tag decisions here.
  const result = NodeChildProcess.spawnSync("bash", ["-s"], {
    encoding: "utf8",
    input: `
node() { return 0; }
openssl() {
  if [[ "$1" == base64 ]]; then cat; else printf fixture; fi
}
npm() {
  case "$1:$3" in
    publish:--access) echo published ;;
    view:dist.integrity)
      case "$SCENARIO" in
        unpublished) echo E404 >&2; return 1 ;;
        wrong-bytes) echo '"sha512-wrong"' ;;
        *) echo '"sha512-fixture"' ;;
      esac ;;
    view:dist-tags)
      [[ "$SCENARIO" != registry-error ]] || return 1
      printf '%s\\n' "$TAGS_JSON" ;;
    *) return 1 ;;
  esac
}
${publishCommand}
`,
    env: {
      ...process.env,
      RELEASE_VERSION: version,
      DIST_TAG: tag,
      SCENARIO: scenario,
      TAGS_JSON: JSON.stringify(
        scenario === "missing" ? {} : { [tag]: scenario === "older" ? "1.2.2" : version },
      ),
    },
  });
  expect(result.status, result.stderr).toBe(
    scenario === "matching" || scenario === "unpublished" ? 0 : 1,
  );
  expect(result.stdout.split("\n").filter((line) => line === "published")).toHaveLength(
    scenario === "unpublished" ? 6 : 0,
  );
  if (scenario === "older" || scenario === "missing") {
    expect(result.stderr).toContain("Repair the channel tag before retrying");
  }
});
