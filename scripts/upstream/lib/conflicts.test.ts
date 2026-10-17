import { assert, describe, it } from "@effect/vitest";

import {
  bracketDelta,
  parseConflictFile,
  renderConflictFile,
  resolveAdditionsHunk,
  resolveHunk,
  resolveIdentityHunk,
  resolveSurroundingAdditionsHunk,
  resolveUpstreamRenameHunk,
} from "./conflicts.ts";

const conflicted = (ours: string, base: string, theirs: string) =>
  `before\n<<<<<<< HEAD\n${ours}||||||| parent of abc (change)\n${base}=======\n${theirs}>>>>>>> abc (change)\nafter\n`;

describe("parseConflictFile", () => {
  it("reads the fork, base, and upstream sections and renders resolved text back in place", () => {
    const file = parseConflictFile(conflicted("ours\n", "base\n", "theirs\n"));
    assert.isNotNull(file);
    assert.deepStrictEqual(file!.hunks, [{ ours: "ours\n", base: "base\n", theirs: "theirs\n" }]);
    assert.strictEqual(renderConflictFile(file!, ["merged\n"]), "before\nmerged\nafter\n");
  });

  it("keeps unresolved hunks as conflict markers", () => {
    const file = parseConflictFile(conflicted("a\n", "b\n", "c\n"))!;
    const rendered = renderConflictFile(file, [null]);
    assert.include(rendered, "<<<<<<< HEAD\na\n||||||| base\nb\n=======\nc\n>>>>>>> upstream\n");
  });

  it("refuses conflicts written without the diff3 base", () => {
    assert.isNull(parseConflictFile("<<<<<<< HEAD\na\n=======\nb\n>>>>>>> abc\n"));
  });
});

describe("resolveIdentityHunk", () => {
  it("carries the fork's product name onto upstream's new text", () => {
    const resolution = resolveIdentityHunk({
      base: '    "Have T3 Code watch a pull request. T3 Code checks it every minute.",\n',
      ours: '    "Have styal watch a pull request. styal checks it every minute.",\n',
      theirs:
        '    "Have T3 Code watch a pull request. T3 Code checks it every two minutes. While T3 Code watches, the thread stays in Working.",\n',
    });
    assert.deepStrictEqual(resolution, {
      kind: "identity",
      text: '    "Have styal watch a pull request. styal checks it every two minutes. While styal watches, the thread stays in Working.",\n',
      replacements: [["T3 Code", "styal"]],
    });
  });

  it("leaves a hunk where upstream renames the same name the fork renamed", () => {
    // Upstream shortened its branch prefix; carrying nothing over would bring `t3` into the fork.
    assert.deepStrictEqual(
      resolveIdentityHunk({
        base: 'it("provisions under t3code-<hash> when a plain t3code branch blocks t3code/*", () =>\n',
        ours: 'it("provisions under styal-<hash> when a plain styal branch blocks styal/*", () =>\n',
        theirs: 'it("provisions under t3-<hash> when a plain t3 branch blocks t3/*", () =>\n',
      }),
      { kind: "unresolved" },
    );
  });

  it("carries a rename when upstream edits a different part of the line", () => {
    assert.deepStrictEqual(
      resolveIdentityHunk({
        base: "      text: `T3 Code stopped watching because it could not read it for ${LIMIT} minutes.`,\n",
        ours: "      text: `styal stopped watching because it could not read it for ${LIMIT} minutes.`,\n",
        theirs:
          "      text: `T3 Code stopped watching because it failed to read it ${LIMIT} times in a row.`,\n",
      }),
      {
        kind: "identity",
        text: "      text: `styal stopped watching because it failed to read it ${LIMIT} times in a row.`,\n",
        replacements: [["T3 Code", "styal"]],
      },
    );
  });

  it("does not explain a fork change that is not a rename", () => {
    assert.deepStrictEqual(
      resolveIdentityHunk({
        base: '    const passedNow = gate.every((check) => check.status !== "pending");\n',
        ours: "    const passedNow = gate.every(isPassedCheck);\n",
        theirs: '    const passedNow = gate.every((check) => check.status === "success");\n',
      }),
      { kind: "unresolved" },
    );
  });
});

describe("resolveAdditionsHunk", () => {
  it("keeps both sides' exports when each adds one at the same place", () => {
    assert.deepStrictEqual(
      resolveAdditionsHunk({
        base: "",
        ours: '\nexport * from "./commandOutput.ts";\n',
        theirs: 'export * from "./secretRequest.ts";\n',
      }),
      {
        kind: "additions",
        text: '\nexport * from "./commandOutput.ts";\nexport * from "./secretRequest.ts";\n',
      },
    );
  });

  it("keeps a shared base line and both sides' additions around it", () => {
    assert.deepStrictEqual(
      resolveAdditionsHunk({
        base: "  Layer.provide(UsageLayerLive),\n",
        ours: "  Layer.provide(UsageLayerLive),\n  Layer.provide(WorkspacePortAllocatorLayerLive),\n",
        theirs:
          "  Layer.provide(UsageLayerLive),\n  Layer.provide(ScheduledTaskWebhookOriginLive),\n",
      }),
      {
        kind: "additions",
        text: "  Layer.provide(UsageLayerLive),\n  Layer.provide(WorkspacePortAllocatorLayerLive),\n  Layer.provide(ScheduledTaskWebhookOriginLive),\n",
      },
    );
  });

  it("leaves a hunk where either side edits upstream's lines", () => {
    assert.deepStrictEqual(
      resolveAdditionsHunk({
        base: "  untracedRequestsLayer,\n",
        ours: "  terminalBrowserOpenRouteLayer,\n  untracedRequestsLayer,\n",
        theirs: "  withUntracedRequests,\n",
      }),
      { kind: "unresolved" },
    );
  });
});

describe("resolveAdditionsHunk supersets", () => {
  it("takes upstream's side when it already contains the fork's added lines", () => {
    assert.deepStrictEqual(
      resolveAdditionsHunk({
        base: "",
        ours: "        const listState = props.listRef.current?.getState();\n",
        theirs:
          "        // A disclosure can leave the reader above the end.\n        const listState = props.listRef.current?.getState();\n",
      }),
      {
        kind: "superset",
        text: "        // A disclosure can leave the reader above the end.\n        const listState = props.listRef.current?.getState();\n",
      },
    );
  });
});

describe("resolveHunk", () => {
  it("never combines lines of a patch or JSON file by position", () => {
    const hunk = { base: "", ours: '  "a": 1,\n', theirs: '  "b": 2\n' };
    assert.strictEqual(
      resolveHunk(hunk, "apps/server/src/provider/model-manifest.json").kind,
      "unresolved",
    );
    assert.strictEqual(resolveHunk(hunk, "patches/effect@4.0.1.patch").kind, "unresolved");
    assert.strictEqual(resolveHunk(hunk, "src/list.ts").kind, "additions");
  });

  it("leaves a semantic conflict for review", () => {
    assert.deepStrictEqual(
      resolveHunk({
        base: "  const onCompactContext = async () => {\n    return;\n  };\n",
        ours: "",
        theirs:
          '  const onCompactContext = () => {\n    void sendStandaloneCommand("/compact");\n  };\n',
      }),
      { kind: "unresolved" },
    );
  });
});

describe("resolveUpstreamRenameHunk", () => {
  it("applies upstream's renames to the fork's side, including lines only the fork has", () => {
    assert.deepStrictEqual(
      resolveUpstreamRenameHunk({
        base: "const socketLayer = makeSocket(url);\nyield* use(socketLayer);\n",
        ours: "const socketLayer = makeSocket(url);\nyield* use(socketLayer);\nyield* count(socketLayer);\n",
        theirs: "const layerSocket = makeSocket(url);\nyield* use(layerSocket);\n",
      }),
      {
        kind: "upstream-rename",
        text: "const layerSocket = makeSocket(url);\nyield* use(layerSocket);\nyield* count(layerSocket);\n",
        replacements: [["socketLayer", "layerSocket"]],
      },
    );
  });

  it("leaves a hunk where upstream does more than rename", () => {
    assert.strictEqual(
      resolveUpstreamRenameHunk({
        base: "const socketLayer = makeSocket(url);\n",
        ours: "const socketLayer = makeSocket(url, options);\n",
        theirs: "const layerSocket = makeSocket(url, { retry: true });\n",
      }).kind,
      "unresolved",
    );
  });
});

describe("resolveSurroundingAdditionsHunk", () => {
  it("keeps the fork's added lines around upstream's edit of the base", () => {
    assert.deepStrictEqual(
      resolveSurroundingAdditionsHunk({
        base: "const makeWsRpcLayer = (\n",
        ours: "export const recordAnalytics = () => Effect.void;\n\nconst makeWsRpcLayer = (\n",
        theirs: "const layerWsRpc = (\n",
      }),
      {
        kind: "surrounding-additions",
        text: "export const recordAnalytics = () => Effect.void;\n\nconst layerWsRpc = (\n",
      },
    );
  });

  it("leaves added lines that open a block closed outside the hunk", () => {
    assert.strictEqual(
      resolveSurroundingAdditionsHunk({
        base: "  return value;\n",
        ours: "function fork() {\n  return value;\n",
        theirs: "  return next;\n",
      }).kind,
      "unresolved",
    );
  });
});

describe("bracketDelta", () => {
  it("counts brackets outside strings and comments", () => {
    assert.strictEqual(bracketDelta(["function a() {", '  log("}");', "  // }"]), 1);
    assert.strictEqual(bracketDelta(["const x = [1, (2)];"]), 0);
  });
});

describe("resolveAdditionsHunk balance", () => {
  it("leaves two half-functions that share a closing brace outside the hunk", () => {
    assert.strictEqual(
      resolveAdditionsHunk({
        base: "",
        ours: "function tokenUsage(projection) {\n  return projection.usage;\n",
        theirs: "function secretRequest(item) {\n  return item.secret;\n",
      }).kind,
      "unresolved",
    );
  });
});

describe("review regressions", () => {
  it("does not treat a changed value as a rename", () => {
    assert.strictEqual(
      resolveUpstreamRenameHunk({
        base: "  a: false,\n",
        ours: "  a: false,\n  forkFlag: false,\n",
        theirs: "  a: true,\n",
      }).kind,
      "unresolved",
    );
  });

  it("keeps every closing line when both sides add a block at the same place", () => {
    const resolution = resolveAdditionsHunk({
      base: "",
      ours: "  a: {\n    x: 1,\n  },\n",
      theirs: "  b: {\n    y: 2,\n  },\n",
    });
    assert.deepStrictEqual(resolution, {
      kind: "additions",
      text: "  a: {\n    x: 1,\n  },\n  b: {\n    y: 2,\n  },\n",
    });
  });

  it("leaves additions that repeat a base line, whose position is ambiguous", () => {
    assert.strictEqual(
      resolveAdditionsHunk({ base: "}\n", ours: "if (x) {\n}\n}\n", theirs: "foo();\n}\n" }).kind,
      "unresolved",
    );
  });

  it("does not rename module paths in upstream's new imports", () => {
    const resolution = resolveIdentityHunk({
      base: '  name: "t3code",\n',
      ours: '  name: "styal",\n',
      theirs: '  name: "t3code",\nimport { x } from "./t3code";\n',
    });
    assert.strictEqual(
      resolution.kind === "identity" ? resolution.text : null,
      '  name: "styal",\nimport { x } from "./t3code";\n',
    );
  });

  it("keeps the fork's addition when upstream's base already has that line", () => {
    const resolution = resolveAdditionsHunk({ base: "b\n", ours: "b\nb2\n", theirs: "b\nc\n" });
    assert.deepStrictEqual(resolution, { kind: "additions", text: "b\nb2\nc\n" });
  });

  it("reads conflict markers in a CRLF file", () => {
    const file = parseConflictFile(
      "a\r\n<<<<<<< HEAD\r\nours\r\n||||||| base\r\nbase\r\n=======\r\ntheirs\r\n>>>>>>> x\r\nb\r\n",
    );
    assert.strictEqual(file?.hunks.length, 1);
  });
});
