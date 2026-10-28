// @effect-diagnostics nodeBuiltinImport:off - runs once at test setup, outside any Effect runtime.
import * as NodeModule from "node:module";

// Each test file starts a fresh worker that compiles the same dependencies again,
// and tests start Node fixtures such as the ACP mock agent dozens of times per file.
// Node's compile cache keeps their bytecode on disk, keyed by file contents and
// Node version. Children inherit it through the environment.
const { directory } = NodeModule.enableCompileCache();
if (directory !== undefined) process.env.NODE_COMPILE_CACHE ??= directory;
