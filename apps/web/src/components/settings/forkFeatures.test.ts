// @effect-diagnostics nodeBuiltinImport:off - reads the fork feature ledger from the repository.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { SETTINGS_BADGED, SETTINGS_FORK_FEATURES, SETTINGS_NOT_BADGED } from "./forkFeatures";
import { SETTINGS_SEARCH_ITEMS } from "./settingsSearch";

const Ledger = Schema.Struct({
  features: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })),
});

it("badges only fork features the ledger still maintains", () => {
  const contents = NodeFS.readFileSync(
    NodeURL.fileURLToPath(new URL("../../../../../.github/fork-features.yml", import.meta.url)),
    "utf8",
  );
  const ledger = Schema.decodeSync(fromYaml(Ledger))(contents);
  const statuses = new Map(ledger.features.map((feature) => [feature.id, feature.status]));

  const stale = SETTINGS_FORK_FEATURES.filter((id) => {
    const status = statuses.get(id);
    return status !== "maintained" && status !== "review-needed";
  });
  expect(stale).toEqual([]);
});

it("classifies only settings search items that exist", () => {
  const ids = new Set<string>(SETTINGS_SEARCH_ITEMS.map((item) => item.id));
  const unknown = [...Object.keys(SETTINGS_BADGED), ...Object.keys(SETTINGS_NOT_BADGED)].filter(
    (id) => !ids.has(id),
  );
  expect(unknown).toEqual([]);
});

it("passes every badge a row can show to a settings row", () => {
  const directory = new URL("./", import.meta.url);
  const source = NodeFS.readdirSync(directory)
    .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
    .map((name) => NodeFS.readFileSync(new URL(name, directory), "utf8"))
    .join("\n");
  const unused = SETTINGS_FORK_FEATURES.filter((id) => !source.includes(`forkFeature="${id}"`));
  expect(unused).toEqual([]);
});
