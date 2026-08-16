import { describe, expect, it } from "vite-plus/test";

import {
  applyDictationVocabulary,
  buildDictationVocabulary,
  spokenWords,
} from "./dictationMatcher.ts";

// Vocabulary and transcripts originate from the measured spike in
// native/dictation-spike (README findings 8-17). The transcripts are real ASR
// output — Parakeet TDT 0.6B over human recordings — embedded here so the
// regression suite is self-contained. Do not "fix" their errors; the errors are
// the test.
const CORPUS_VOCABULARY = [
  "ChildProcessSpawner",
  "FileSystem",
  "HTTPClient",
  "HTTPRequest",
  "ProviderInstanceId",
  "apiUrl",
  "base64Encode",
  "createdAt",
  "environmentId",
  "exitCode",
  "forEach",
  "getUser",
  "getUsers",
  "isEmpty",
  "isValid",
  "mapError",
  "onChange",
  "onClick",
  "parseURL",
  "threadId",
  "thread_id",
  "toJSON",
  "toString",
  "updatedAt",
  "useState",
  "userId",
  "workspaceRoot",
  "worktreePath",
];

const vocabulary = buildDictationVocabulary(CORPUS_VOCABULARY);

const match = (text: string) => applyDictationVocabulary(text, vocabulary);
const substituted = (text: string) => match(text).substitutions.map((s) => s.after);

describe("spokenWords", () => {
  it("splits camelCase", () => {
    expect(spokenWords("worktreePath")).toEqual(["worktree", "path"]);
    expect(spokenWords("createdAt")).toEqual(["created", "at"]);
  });

  it("splits PascalCase", () => {
    expect(spokenWords("ChildProcessSpawner")).toEqual(["child", "process", "spawner"]);
  });

  it("keeps acronym runs as one word", () => {
    // Splitting per capital produced "h t t p client" (5 words), which the
    // window-size filter rejected against the 2-token phrase the speech model
    // actually emits (finding 9).
    expect(spokenWords("HTTPClient")).toEqual(["http", "client"]);
    expect(spokenWords("parseURL")).toEqual(["parse", "url"]);
    expect(spokenWords("toJSON")).toEqual(["to", "json"]);
  });

  it("splits snake_case and kebab-case", () => {
    expect(spokenWords("thread_id")).toEqual(["thread", "id"]);
    expect(spokenWords("some-flag")).toEqual(["some", "flag"]);
  });

  it("keeps digits attached to their word", () => {
    expect(spokenWords("base64Encode")).toEqual(["base64", "encode"]);
  });
});

describe("buildDictationVocabulary", () => {
  it("collapses spoken-form collisions, first occurrence winning", () => {
    // threadId and thread_id are both "thread id". Without the collapse the
    // ambiguity margin refuses to guess between them and the identifier is
    // lost entirely (finding 16).
    const entries = buildDictationVocabulary(["threadId", "thread_id", "mapError"]);
    expect(entries.map((entry) => entry.identifier)).toEqual(["threadId", "mapError"]);
  });
});

describe("applyDictationVocabulary — recovery", () => {
  // Real Parakeet transcript of an independent speaker reading corpus-remote.txt
  // (finding 16: 91% recall, both misses deliberate refusals).
  const WOODHOUSE_CODE =
    "Read the WorktreePath from the environment id, then call parse URL on the API URL " +
    "and pass the result to to JSON. The HTTP client needs the user ID before it can " +
    "send the HTTP request. If the response is empty, call mapError on the file system " +
    "layer and check the exit code. Run for each over the rows. Call to string on each " +
    "one and confirm the value as valid before writing created at and updated at. " +
    "Remember, get user returns one row, but get users returns many, and the thread ID " +
    "lives in the base64 encode helper in workspace root.";

  it("recovers identifiers from a real transcript of a second speaker", () => {
    const result = match(WOODHOUSE_CODE);
    for (const identifier of [
      "worktreePath",
      "environmentId",
      "parseURL",
      "apiUrl",
      "toJSON",
      "HTTPClient",
      "userId",
      "HTTPRequest",
      "isEmpty",
      "FileSystem",
      "exitCode",
      "forEach",
      "toString",
      "createdAt",
      "updatedAt",
      "getUser",
      "getUsers",
      "threadId",
      "base64Encode",
      "workspaceRoot",
    ]) {
      expect(result.text).toContain(identifier);
    }
  });

  it("refuses 'as valid' — boundary stopword that is not the identifier's own word", () => {
    // The ASR heard "confirm the value as valid"; "as" is a boundary stopword
    // and isValid's spoken form starts with "is", so the waiver must not apply.
    const result = match("confirm the value as valid before writing");
    expect(result.substitutions).toEqual([]);
  });

  it("matches identifiers whose spoken form begins with a stopword", () => {
    // isEmpty/onClick/forEach/toString were structurally unmatchable until the
    // guard was waived for the candidate's own boundary words (finding 9).
    expect(substituted("check if the list is empty before you call on click")).toEqual([
      "isEmpty",
      "onClick",
    ]);
    expect(substituted("the handler runs for each item and returns to string")).toEqual([
      "forEach",
      "toString",
    ]);
  });

  it("repairs split and merged words via space-stripped comparison", () => {
    expect(substituted("update the work tree path")).toEqual(["worktreePath"]);
    expect(substituted("read the thread id")).toEqual(["threadId"]);
  });
});

describe("applyDictationVocabulary — refusals", () => {
  it("never spans a token carrying trailing punctuation", () => {
    // "exit. The code" must not become exitCode — and the ASR sometimes renders
    // that boundary as a comma, so the rule covers all trailing punctuation
    // (findings 10, 11).
    expect(substituted("I need to exit. The code count is high")).toEqual([]);
    expect(substituted("I called exit, the code path after that never runs")).toEqual([]);
  });

  it("does not absorb neighbouring function words", () => {
    // "map the error" scored 0.727 against mapError under a ratio threshold;
    // the edit budget rejects the extra token (finding 10).
    expect(substituted("I need to map the error message somewhere")).toEqual([]);
    expect(substituted("Update the settings now")).toEqual([]);
  });

  it("rejects near-misses that a ratio threshold accepted", () => {
    // "change" and "exchange" both scored exactly 0.75 against onChange —
    // two edits on an 8-character candidate (finding 9).
    expect(substituted("please change the deadline")).toEqual([]);
    expect(substituted("the exchange rate moved")).toEqual([]);
  });

  it("resolves near-miss identifier pairs by score, not vocabulary order", () => {
    expect(substituted("call get user and then get users")).toEqual(["getUser", "getUsers"]);
  });
});

describe("applyDictationVocabulary — deterministic phrase collisions", () => {
  // Real Parakeet transcript of the prose control. The collisions below are
  // guaranteed consequences of correct transcription — six TTS voices across
  // five locales produced identical results (finding 15). If a change to the
  // matcher makes these disappear, it has broken recall of isEmpty/isValid,
  // not fixed a bug; the product mitigation is marked substitutions in the UI.
  const WOODHOUSE_PROSE =
    "The room is empty, so please turn off the lights on your way out. It's valid to " +
    "change your mind before the deadline, and I had to click through each item to " +
    "check they were all correct. Map the error back to whoever reported it, then " +
    "update the result and filter the list so the count comes out right. I called " +
    "exit, but the code path after that never runs";

  it("collides exactly where finding 15 predicts, and nowhere else", () => {
    expect(substituted(WOODHOUSE_PROSE)).toEqual(["isEmpty", "isValid"]);
  });
});

describe("applyDictationVocabulary — output fidelity", () => {
  it("preserves leading punctuation, trailing punctuation and newlines", () => {
    const result = match(
      "wrap the work tree path (and the exit code) in parens\nthen check the file system",
    );
    expect(result.text).toBe(
      "wrap the worktreePath (and the exitCode) in parens\nthen check the FileSystem",
    );
  });

  it("reports substitution offsets into the output text", () => {
    const result = match("call map error on the file system layer");
    for (const substitution of result.substitutions) {
      expect(result.text.slice(substitution.outputStart, substitution.outputEnd)).toBe(
        substitution.after,
      );
    }
  });

  it("reports offsets correctly across lines", () => {
    const result = match("check the exit code\nthen the work tree path");
    expect(result.substitutions).toHaveLength(2);
    for (const substitution of result.substitutions) {
      expect(result.text.slice(substitution.outputStart, substitution.outputEnd)).toBe(
        substitution.after,
      );
    }
  });

  it("returns prose untouched when nothing matches", () => {
    const input = "The quick brown fox jumps over the lazy dog near the riverbank.";
    const result = match(input);
    expect(result.text).toBe(input);
    expect(result.substitutions).toEqual([]);
  });
});
