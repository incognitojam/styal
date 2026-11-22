// @effect-diagnostics nodeBuiltinImport:off -- Startup removes only the retired sign-in files before Electron is ready.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const CLERK_TOKEN_DIRECTORY_NAME = "clerk";
const CLERK_TOKEN_FILE_NAME = "clerk-tokens.json";

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function lstatIfExists(path: string): NodeFS.Stats | undefined {
  try {
    return NodeFS.lstatSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

/** Removes only the retired token files, without following a Clerk directory symlink. */
export function removeClerkTokenStorage(stateDir: string, userDataPath: string): void {
  for (const root of new Set([stateDir, userDataPath])) {
    const directory = NodePath.join(root, CLERK_TOKEN_DIRECTORY_NAME);
    const stat = lstatIfExists(directory);
    if (stat !== undefined) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("The retired sign-in directory must be a real directory.");
      }
      const tokenPath = NodePath.join(directory, CLERK_TOKEN_FILE_NAME);
      if (lstatIfExists(tokenPath) !== undefined) NodeFS.unlinkSync(tokenPath);
    }
    const legacyPath = NodePath.join(root, CLERK_TOKEN_FILE_NAME);
    if (lstatIfExists(legacyPath) !== undefined) NodeFS.unlinkSync(legacyPath);
  }
}
