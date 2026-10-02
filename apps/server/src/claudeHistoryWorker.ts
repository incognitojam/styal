import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

import { readClaudeSessionHistory } from "./provider/claudeSessionHistory.ts";

// A separate process gives SDK history helpers the provider's environment without
// mutating the server's environment. This entry is bundled alongside the server.
const [method, sessionId, rawOptions] = process.argv.slice(2);
const options = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      dir: Schema.optionalKey(Schema.String),
      upToMessageId: Schema.optionalKey(Schema.String),
    }),
  ),
)(rawOptions ?? "{}");
if (!sessionId) throw new Error("Claude history session id is required.");
const result =
  method === "readSessionHistory"
    ? await readClaudeSessionHistory(sessionId, options)
    : method === "forkSession"
      ? await forkSession(sessionId, options)
      : (() => {
          throw new Error("Unknown Claude history operation.");
        })();
process.stdout.write(JSON.stringify(result));
