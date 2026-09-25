import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// GNU tar can restore pnpm directory junctions as file symlinks when their
// targets have not been extracted yet. Recreate those links after extraction.
let repaired = 0;
function repairLinks(directory) {
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (NodeFS.existsSync(path)) continue;
      const target = NodePath.resolve(NodePath.dirname(path), NodeFS.readlinkSync(path));
      if (!NodeFS.statSync(target).isDirectory()) {
        throw new Error(`Expected a directory target for cached dependency link: ${path}`);
      }
      NodeFS.unlinkSync(path);
      NodeFS.symlinkSync(target, path, "junction");
      repaired++;
    } else if (entry.isDirectory()) {
      repairLinks(path);
    }
  }
}

for (const directory of NodeFS.globSync([
  "node_modules",
  "apps/*/node_modules",
  "packages/*/node_modules",
  "infra/*/node_modules",
  "scripts/node_modules",
  "oxlint-plugin-t3code/node_modules",
])) {
  repairLinks(directory);
}
console.log(`Repaired ${repaired} cached dependency junctions.`);
