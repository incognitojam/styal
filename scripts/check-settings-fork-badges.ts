#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const SEARCH_PATH = "apps/web/src/components/settings/settingsSearch.ts";
const CLASSIFICATION_PATH = "apps/web/src/components/settings/forkFeatures.ts";
const UPSTREAM_REF = process.env.UPSTREAM_REF ?? "upstream/main";

const searchItemIds = (source: string) =>
  [...source.matchAll(/^ {4}id: "([^"]+)",$/gm)].flatMap((match) => match[1] ?? []);

const upstream = new Set(
  searchItemIds(
    NodeChildProcess.execFileSync("git", ["show", `${UPSTREAM_REF}:${SEARCH_PATH}`], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
  ),
);
const readRepoFile = (path: string) => NodeFS.readFileSync(NodePath.join(repoRoot, path), "utf8");
// The keys of SETTINGS_BADGED and SETTINGS_NOT_BADGED; the scripts project cannot import web code.
const classified = new Set(
  [...readRepoFile(CLASSIFICATION_PATH).matchAll(/^ {2}"?([\w-]+)"?:/gm)].flatMap(
    (match) => match[1] ?? [],
  ),
);
const unclassified = searchItemIds(readRepoFile(SEARCH_PATH)).filter(
  (id) => !upstream.has(id) && !classified.has(id),
);

if (unclassified.length === 0) {
  process.stdout.write("Every styal-only settings search item is classified.\n");
} else {
  for (const id of unclassified) {
    process.stdout.write(
      `::error file=${SEARCH_PATH},title=Unclassified styal setting::${id} is not in upstream's settings. Pass forkFeature on its row and add it to SETTINGS_BADGED, or add it to SETTINGS_NOT_BADGED with the reason.\n`,
    );
  }
  process.exitCode = 1;
}
