import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { skillFiles } from "../../agent-skills/files.ts";

export const materialize = Effect.fn("AgentSkills.materialize")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(stateDir, "agent-skills", "styal");
  for (const [name, contents] of Object.entries(skillFiles)) {
    const target = path.join(directory, name);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, contents);
  }
  return directory;
});
