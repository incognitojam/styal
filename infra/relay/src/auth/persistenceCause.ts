/**
 * What an auth persistence error keeps of its database cause. Driver errors
 * carry the query and its parameters, which here include email addresses, and
 * failed spans record the whole error, so only the error's name and SQL state
 * survive.
 */
export function persistenceCause(cause: unknown): {
  readonly name: string;
  readonly code?: string;
} {
  if (typeof cause !== "object" || cause === null) return { name: "unknown" };
  const name =
    "_tag" in cause && typeof cause._tag === "string"
      ? cause._tag
      : "name" in cause && typeof cause.name === "string"
        ? cause.name
        : "unknown";
  const inner = "cause" in cause ? cause.cause : undefined;
  const code =
    typeof inner === "object" && inner !== null && "code" in inner && typeof inner.code === "string"
      ? inner.code
      : "code" in cause && typeof cause.code === "string"
        ? cause.code
        : undefined;
  return code === undefined ? { name } : { name, code };
}
