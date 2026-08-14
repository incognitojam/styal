/**
 * Resolving the references a body names in one request: repositories become aliased fields,
 * numbers aliased fields inside them, and `issueOrPullRequest` says which kind each is.
 *
 * A partial answer is the normal answer — the host nulls what it cannot show — and `gh` exits
 * non-zero for it, so the caller reads this body rather than the exit code.
 */
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

export interface GitHubReferenceRequest {
  readonly repository: string;
  readonly number: number;
}

export interface GitHubResolvedReference {
  readonly repository: string;
  readonly number: number;
  /** Null when the host has nothing under this number. */
  readonly kind: "issue" | "pull-request" | null;
  readonly title: string | null;
  readonly state: "open" | "draft" | "closed" | "merged" | null;
  readonly url: string | null;
}

/** GitHub scores a query before running it. A body citing more than this is quoting a changelog. */
export const MAX_REFERENCES_PER_REQUEST = 40;

const REFERENCE_FIELDS = `__typename
      ... on Issue { title url state }
      ... on PullRequest { title url state isDraft }`;

interface ReferenceAlias {
  readonly reference: GitHubReferenceRequest;
  readonly repositoryAlias: string;
  readonly numberAlias: string;
}

/** `owner/repo`, split the way the host addresses it. */
export function splitRepository(repository: string): { owner: string; name: string } | null {
  const segments = repository.split("/");
  const owner = segments[0]?.trim();
  const name = segments[1]?.trim();
  return segments.length === 2 && owner && name ? { owner, name } : null;
}

/**
 * The query, its variables, and where each reference's answer will be found. Owner and name travel
 * as variables because they are words a body wrote; numbers are integers by the time they arrive.
 */
export function buildGitHubReferenceQuery(references: ReadonlyArray<GitHubReferenceRequest>): {
  readonly query: string;
  readonly variables: Record<string, string>;
  readonly aliases: ReadonlyArray<ReferenceAlias>;
} | null {
  const byRepository = new Map<string, { owner: string; name: string; numbers: Array<number> }>();
  const aliases: Array<ReferenceAlias> = [];

  for (const reference of references.slice(0, MAX_REFERENCES_PER_REQUEST)) {
    const split = splitRepository(reference.repository);
    if (split === null) continue;
    const key = reference.repository.toLowerCase();
    const group = byRepository.get(key) ?? { ...split, numbers: [] };
    if (!group.numbers.includes(reference.number)) group.numbers.push(reference.number);
    byRepository.set(key, group);
    aliases.push({
      reference,
      repositoryAlias: `r${[...byRepository.keys()].indexOf(key)}`,
      numberAlias: `i${group.numbers.indexOf(reference.number)}`,
    });
  }
  if (byRepository.size === 0) return null;

  const variables: Record<string, string> = {};
  const declarations: Array<string> = [];
  const fields: Array<string> = [];
  let index = 0;
  for (const group of byRepository.values()) {
    variables[`o${index}`] = group.owner;
    variables[`n${index}`] = group.name;
    declarations.push(`$o${index}: String!, $n${index}: String!`);
    const numbers = group.numbers
      .map(
        (number, numberIndex) =>
          `i${numberIndex}: issueOrPullRequest(number: ${number}) { ${REFERENCE_FIELDS} }`,
      )
      .join("\n    ");
    fields.push(
      `r${index}: repository(owner: $o${index}, name: $n${index}) {\n    ${numbers}\n  }`,
    );
    index += 1;
  }

  return {
    query: `query(${declarations.join(", ")}) {\n  ${fields.join("\n  ")}\n}`,
    variables,
    aliases,
  };
}

const ReferenceNodeSchema = Schema.Struct({
  __typename: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

/**
 * The errors beside the data are part of the answer: `NOT_FOUND` means nothing is under that
 * number, while `FORBIDDEN` — SAML, an IP allowlist, a token scoped elsewhere — means the host
 * declined to say, about something the reader may well be able to open themselves.
 */
const ReferenceErrorSchema = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});

const ReferenceResponseSchema = Schema.Struct({
  data: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(Schema.Unknown)))),
  errors: Schema.optional(Schema.NullOr(Schema.Array(ReferenceErrorSchema))),
});

const decodeReferenceResponse = decodeJsonResult(ReferenceResponseSchema);

/** The error type filed against each failed path, keyed as `r0` or `r0/i1`. */
function errorTypesByPath(
  errors: ReadonlyArray<Schema.Schema.Type<typeof ReferenceErrorSchema>>,
): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const error of errors) {
    const path = (error.path ?? []).filter((segment) => typeof segment === "string");
    const type = error.type?.trim().toUpperCase();
    if (path.length === 0 || type === undefined) continue;
    byPath.set(path.join("/"), type);
  }
  return byPath;
}
const decodeReferenceNode = Schema.decodeUnknownExit(ReferenceNodeSchema);

function normalizeState(
  raw: Schema.Schema.Type<typeof ReferenceNodeSchema>,
  kind: "issue" | "pull-request",
): "open" | "draft" | "closed" | "merged" | null {
  const state = raw.state?.trim().toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  if (state !== "OPEN") return null;
  return kind === "pull-request" && raw.isDraft === true ? "draft" : "open";
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

/**
 * The answers, in the order they were asked for. A reference is left out unless the host was clear
 * about it, since an omitted answer renders as an ordinary link while a wrong one calls a
 * reference that exists a mistake.
 */
export function decodeGitHubReferenceResponseJson(
  raw: string,
  aliases: ReadonlyArray<ReferenceAlias>,
): Result.Result<ReadonlyArray<GitHubResolvedReference>, Cause.Cause<Schema.SchemaError>> {
  const decoded = decodeReferenceResponse(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const data = decoded.success.data ?? {};
  const errorTypes = errorTypesByPath(decoded.success.errors ?? []);

  const resolved: Array<GitHubResolvedReference> = [];
  for (const alias of aliases) {
    // Unresolved at either level, and whether it came back as a null or not at all, reads the
    // same. Only the host's own `NOT_FOUND` makes it a statement about the reference.
    const nothingThere =
      errorTypes.get(`${alias.repositoryAlias}/${alias.numberAlias}`) === "NOT_FOUND" ||
      errorTypes.get(alias.repositoryAlias) === "NOT_FOUND";
    const repository = data[alias.repositoryAlias];
    const numbers =
      repository !== null && typeof repository === "object"
        ? (repository as Record<string, unknown>)
        : undefined;
    const node = numbers?.[alias.numberAlias];
    if (node === null || node === undefined) {
      if (nothingThere) {
        resolved.push({
          repository: alias.reference.repository,
          number: alias.reference.number,
          kind: null,
          title: null,
          state: null,
          url: null,
        });
      }
      continue;
    }
    const decodedNode = decodeReferenceNode(node);
    // A shape this does not recognise is not a missing issue; say nothing about it.
    if (Exit.isFailure(decodedNode)) continue;
    const typename = decodedNode.value.__typename?.trim();
    const kind =
      typename === "PullRequest" ? "pull-request" : typename === "Issue" ? "issue" : null;
    if (kind === null) continue;
    resolved.push({
      repository: alias.reference.repository,
      number: alias.reference.number,
      kind,
      title: trimmed(decodedNode.value.title),
      state: normalizeState(decodedNode.value, kind),
      url: trimmed(decodedNode.value.url),
    });
  }
  return Result.succeed(resolved);
}
