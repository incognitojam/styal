// @effect-diagnostics nodeBuiltinImport:off - reads the fork feature ledger from the repository.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { SETTINGS_FORK_FEATURES } from "./forkFeatures";

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
