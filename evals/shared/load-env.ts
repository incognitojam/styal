// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

const path = NodePath.join(NodeOS.homedir(), ".config/styal/evals.env");
if (NodeFS.existsSync(path)) NodeProcess.loadEnvFile(path);
