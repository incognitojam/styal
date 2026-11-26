import * as Schema from "effect/Schema";
import { useLocalStorage } from "./hooks/useLocalStorage";
const schema = Schema.Record(Schema.String, Schema.Boolean);
export function useOutagePreferences() {
  return useLocalStorage("styal:service-outage-notices", {}, schema);
}
