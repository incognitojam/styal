import { createWorktreeCleanupAtoms } from "@t3tools/client-runtime/state/worktreeCleanup";

import { connectionAtomRuntime } from "../connection/runtime";

export const worktreeCleanup = createWorktreeCleanupAtoms(connectionAtomRuntime);
