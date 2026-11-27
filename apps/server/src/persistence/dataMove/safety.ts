// @effect-diagnostics nodeBuiltinImport:off - Offline SQLite tooling needs synchronous Node file and descriptor operations.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const isLivePath = (path: string) =>
  [NodeOS.homedir(), NodeOS.userInfo().homedir].some((home) => {
    const live = NodePath.join(home, ".styal/userdata");
    return path === live || path.startsWith(live + NodePath.sep);
  });
