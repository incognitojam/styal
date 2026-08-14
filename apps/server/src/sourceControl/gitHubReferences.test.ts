import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  buildGitHubReferenceQuery,
  decodeGitHubReferenceResponseJson,
  MAX_REFERENCES_PER_REQUEST,
  splitRepository,
} from "./gitHubReferences.ts";

const REFERENCES = [
  { repository: "pingdotgg/t3code", number: 6039 },
  { repository: "pingdotgg/t3code", number: 2243 },
  { repository: "other/repo", number: 7 },
];

function build(references: ReadonlyArray<{ repository: string; number: number }>) {
  const built = buildGitHubReferenceQuery(references);
  if (built === null) throw new Error("expected a query");
  return built;
}

describe("buildGitHubReferenceQuery", () => {
  it("asks one repository field per repository, whatever the order they are written in", () => {
    const built = build(REFERENCES);

    expect(built.variables).toEqual({
      o0: "pingdotgg",
      n0: "t3code",
      o1: "other",
      n1: "repo",
    });
    // One repository field per repository, one number field inside it, and no reference sharing
    // an address with another — the spelling of the aliases is the builder's own business.
    expect(new Set(built.aliases.map((alias) => alias.repositoryAlias))).toHaveLength(2);
    expect(
      new Set(built.aliases.map((alias) => `${alias.repositoryAlias}/${alias.numberAlias}`)),
    ).toHaveLength(3);
  });

  it("carries the repository as a variable, never as part of the document", () => {
    const built = build([{ repository: 'ev"il/re"po', number: 1 }]);

    expect(built.query).not.toContain("ev");
    expect(built.variables.o0).toBe('ev"il');
  });

  it("skips anything that is not owner/repo, and says nothing when none are left", () => {
    expect(buildGitHubReferenceQuery([{ repository: "justaname", number: 1 }])).toBeNull();
    expect(buildGitHubReferenceQuery([])).toBeNull();
    expect(splitRepository("owner/repo/extra")).toBeNull();
  });

  it("stops at the ceiling rather than pricing a whole changelog into one request", () => {
    const many = Array.from({ length: MAX_REFERENCES_PER_REQUEST + 10 }, (_, index) => ({
      repository: "pingdotgg/t3code",
      number: index + 1,
    }));

    expect(build(many).aliases).toHaveLength(MAX_REFERENCES_PER_REQUEST);
  });
});

describe("decodeGitHubReferenceResponseJson", () => {
  function decode(body: unknown) {
    const decoded = decodeGitHubReferenceResponseJson(
      JSON.stringify(body),
      build(REFERENCES).aliases,
    );
    if (!Result.isSuccess(decoded)) throw new Error("expected a decoded body");
    return decoded.success;
  }

  it("reads a pull request, an issue, and the null the host called NOT_FOUND", () => {
    const resolved = decode({
      data: {
        r0: {
          i0: { __typename: "PullRequest", title: "A fix", url: "https://x/1", state: "MERGED" },
          i1: null,
        },
        r1: { i0: { __typename: "Issue", title: "A bug", url: "https://x/2", state: "OPEN" } },
      },
      errors: [{ type: "NOT_FOUND", path: ["r0", "i1"] }],
    });

    expect(resolved).toEqual([
      {
        repository: "pingdotgg/t3code",
        number: 6039,
        kind: "pull-request",
        title: "A fix",
        state: "merged",
        url: "https://x/1",
      },
      {
        repository: "pingdotgg/t3code",
        number: 2243,
        kind: null,
        title: null,
        state: null,
        url: null,
      },
      {
        repository: "other/repo",
        number: 7,
        kind: "issue",
        title: "A bug",
        state: "open",
        url: "https://x/2",
      },
    ]);
  });

  it("reads a draft as its own state, which is what the badge says", () => {
    const resolved = decode({
      data: {
        r0: {
          i0: {
            __typename: "PullRequest",
            title: "WIP",
            url: "https://x/1",
            state: "OPEN",
            isDraft: true,
          },
        },
      },
    });

    expect(resolved[0]?.state).toBe("draft");
  });

  it("says nothing about a null the host did not explain", () => {
    const resolved = decode({ data: { r0: { i0: null, i1: null } } });

    expect(resolved).toEqual([]);
  });

  it("does not call a reference missing when the host merely refused to show it", () => {
    // FORBIDDEN is SAML, an IP allowlist, or a token scoped elsewhere — all things the reader may
    // well be able to open themselves, so the link stays an ordinary one.
    const resolved = decode({
      data: { r0: { i0: null, i1: null }, r1: { i0: null } },
      errors: [
        { type: "FORBIDDEN", path: ["r0", "i0"] },
        { type: "NOT_FOUND", path: ["r0", "i1"] },
        { type: "FORBIDDEN", path: ["r1"] },
      ],
    });

    expect(resolved).toEqual([
      {
        repository: "pingdotgg/t3code",
        number: 2243,
        kind: null,
        title: null,
        state: null,
        url: null,
      },
    ]);
  });

  it("marks every number under a repository the host has nothing under", () => {
    const resolved = decode({
      data: {
        r0: null,
        r1: { i0: { __typename: "Issue", title: "A bug", url: "u", state: "OPEN" } },
      },
      errors: [{ type: "NOT_FOUND", path: ["r0"] }],
    });

    expect(resolved.filter((reference) => reference.kind === null).map((r) => r.number)).toEqual([
      6039, 2243,
    ]);
    expect(resolved[2]?.kind).toBe("issue");
  });

  it("fails on a body that is not an answer at all, so the caller can say why", () => {
    const decoded = decodeGitHubReferenceResponseJson("", build(REFERENCES).aliases);

    expect(Result.isSuccess(decoded)).toBe(false);
  });
});
