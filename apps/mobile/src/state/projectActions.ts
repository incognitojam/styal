import { createProjectActionAtoms } from "@t3tools/client-runtime/state/projectActions";
import { connectionAtomRuntime } from "../connection/runtime";

export const projectActions = createProjectActionAtoms(connectionAtomRuntime);
