import { createProjectFileActionAtoms } from "@t3tools/client-runtime/state/projectFileActions";

import { connectionAtomRuntime } from "../connection/runtime";

export const projectFileActions = createProjectFileActionAtoms(connectionAtomRuntime);
