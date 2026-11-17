import { createRegenerableFilesAtoms } from "@t3tools/client-runtime/state/regenerableFiles";

import { connectionAtomRuntime } from "../connection/runtime";

export const regenerableFiles = createRegenerableFilesAtoms(connectionAtomRuntime);
