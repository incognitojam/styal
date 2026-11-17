// @effect-diagnostics-next-line nodeBuiltinImport:off -- Physical deletion must bypass Electron's patched FileSystem.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";

// Keep Electron's archive-aware fs for module loading; only physical tree operations use this one.
export const getPhysicalFileSystem = (): typeof NodeFS =>
  process.versions.electron ? NodeModule.createRequire(import.meta.url)("original-fs") : NodeFS;
