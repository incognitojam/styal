// @effect-diagnostics nodeBuiltinImport:off -- The SDK must load from disk beside its Webpack chunks.
import * as NodeModule from "node:module";

// createRequire loads the disk-backed SDK and adjacent chunks even from a Node SEA executable.
const requireCursorSdk = NodeModule.createRequire(import.meta.url);
export const cursorSdkModulePath = requireCursorSdk.resolve("@cursor/sdk");
// Loading the SDK evaluates its generated protocol and native helpers. An unused
// Cursor provider must not make that work part of server startup.
export const loadCursorSdk = () => {
  const start = performance.now();
  const sdk = requireCursorSdk("@cursor/sdk") as typeof import("@cursor/sdk");
  if (process.env.T3CODE_STARTUP_PROFILE_DIR) {
    performance.measure("provider.cursor.importSdk", { start });
  }
  return sdk;
};
export const loadCursorSqliteSdk = () => {
  const start = performance.now();
  const sqlite = requireCursorSdk("@cursor/sdk/sqlite") as typeof import("@cursor/sdk/sqlite");
  if (process.env.T3CODE_STARTUP_PROFILE_DIR) {
    performance.measure("provider.cursor.importSqliteStore", { start });
  }
  return sqlite;
};
