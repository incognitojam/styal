import { ScheduledTaskThreadListResult } from "@t3tools/contracts";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(ScheduledTaskThreadListResult));

export function rememberProjectJobs(
  environmentId: string,
  current: ScheduledTaskThreadListResult | null,
  storage: () => Pick<Storage, "getItem" | "setItem"> = () => window.localStorage,
): ScheduledTaskThreadListResult | null {
  try {
    const key = `styal:project-jobs:${environmentId}`;
    if (current !== null) storage().setItem(key, JSON.stringify(current));
    return current ?? Option.getOrNull(decode(storage().getItem(key)));
  } catch {
    return current;
  }
}

export function clearProjectJobs(
  environmentId: string,
  storage: () => Pick<Storage, "removeItem"> = () => window.localStorage,
): void {
  try {
    storage().removeItem(`styal:project-jobs:${environmentId}`);
  } catch {
    // Storage can be blocked in a private browser.
  }
}
