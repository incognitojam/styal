# Dictation spike — SpeechAnalyzer

Throwaway spike answering three questions about Apple's `SpeechAnalyzer` before
committing to a dictation design. Not wired into the app; not shipped.

Requires macOS 26+ (Apple Silicon). Built against SDK 26.5, Swift 6.3.2.

```sh
swift build
./.build/debug/t3-dictate info
./extract-vocab.sh ../.. 2000 > /tmp/vocab-2000.txt
say -v Samantha -r 175 -o /tmp/sample.aiff "…"
./ab-test.sh /tmp/sample.aiff /tmp/vocab-2000.txt
```

`record` / `live` use the microphone and will trigger a TCC prompt attributed to
the terminal. `file` is deterministic and needs no permission.

**Run from Terminal.app or iTerm.** Microphone grants belong to the parent app,
and an app without `NSMicrophoneUsageDescription` cannot be prompted at all — TCC
stays silent and `AVAudioEngine` returns digital silence instead of an error. A
recording made from T3 Code's own embedded terminal came back at -inf dBFS with
`microphoneAuthorization: notDetermined`. `record` and `file` now both refuse
silent audio rather than reporting an empty transcript.

## Findings

### 1. `contextualStrings` works — but only on `DictationTranscriber`

This is the headline. `SpeechTranscriber` silently ignores the vocabulary;
`DictationTranscriber` honours it and produces correctly-cased identifiers.

Same 45s human recording, "call map error on the file system layer and then
check the exit code":

| module | output |
|---|---|
| `SpeechTranscriber` (any vocab size) | "call map error on the file system layer … check the exit code" |
| `DictationTranscriber` + vocab | "call **mapError** on the **FileSystem** layer … check the **exitCode**" |

Across the sample, `DictationTranscriber` + vocabulary correctly recovered
`worktreePath`, `mapError`, `FileSystem`, `exitCode`, `workspaceRoot`,
`modelSelection`, `runtimeMode`, `flatMap` and `ChildProcessSpawner` — none of
which `SpeechTranscriber` got at any vocabulary size. It also fixed a homophone:
"workspace route" → `workspaceRoot`.

**Smaller vocabularies work better.** A focused 20-term list produced
`ChildProcessSpawner`; the same audio with 2003 terms degraded it to
"ChildProcess spawn". Send symbols relevant to the current context, not the whole
repo.

**The trade-off:** `DictationTranscriber` has a weaker baseline. It dropped words
("both depend on" → "both the"), ran sentences together, and did worse on novel
proper nouns ("Fnorbulator" → "snoop", where `SpeechTranscriber` managed
"finobulator"). Enabling `.punctuation` explicitly changed nothing.

**Not fixable by biasing:** `threadId`/`threadRef` stayed "Fred ID"/"Fred ref"
(and "free ID" with the focused list), `useMemo` → "use me", `createdAt`/
`updatedAt` → "created that"/"updated that", `ProviderInstanceId` → "provider at
the end of". All three invented words failed everywhere. Where the acoustics are
lost, no vocabulary recovers them.

`DictationTranscriber` is also the module carrying
`ContentHint.customizedLanguage(modelConfiguration:)`, so the full
`SFCustomLanguageModelData` path is available on the engine that demonstrably
uses vocabulary. That is the obvious next experiment for the residual misses.

### 1b. Custom language models do nothing (`ContentHint.customizedLanguage`)

The `SFCustomLanguageModelData` pipeline builds fine and applies nothing.

Building works and is cheap: export 5-7ms, `prepareCustomLanguageModel` ~1.0-1.2s,
producing a 6.5 MB `model.lm` and a 20 KB `vocab.lm`. No errors at any stage.

Applying it changed the transcript in zero of five configurations — plain
`PhraseCount` unigrams, `TemplatePhraseCountGenerator` with 16 sentence frames at
count 1000, and `weight` at unset / 0.5 / 1.0. Every result was byte-identical to
the plain `DictationTranscriber` baseline, and every "custom LM + contextualStrings"
run was byte-identical to contextualStrings alone.

The clincher: replacing `model.lm` with the literal bytes `garbage` also produced
no error and no change. A model that was actually being loaded would fail. The
content hint is being ignored, not merely proving ineffective.

Caveat: this cannot fully exclude an undocumented requirement (an entitlement, or
the hint only being honoured via the legacy `SFSpeechRecognizer` path). But three
independent configurations plus the corruption test all point the same way.

**Consequence:** there is nothing to train, cache, or invalidate per project. The
whole per-project model-management design collapses into "pass a string array",
which `setContext` can swap mid-session for free.

### 1a. Superseded: the original `SpeechTranscriber`-only result

Transcripts were **byte-identical** across vocabulary sizes 0, 50, 200, 500 and
2000, on a sample deliberately full of terms present in the vocabulary
(`worktreePath`, `createdAt`, `environmentId`, `threadRef`, `mapError`).

Confirmed not to be a wiring bug:

- passing via `SpeechAnalyzer(analysisContext:)` and calling `setContext(_:)`
  explicitly after construction both behave the same
- reading back `analyzer.context.contextualStrings[.general]` returns exactly the
  terms supplied, so the API accepts and retains them
- an out-of-vocabulary test (`Zyglorp`, `Fnorbulator`) — the documented use case,
  "words that should be recognized even if they are not in the system
  vocabulary" — also produced identical output (`Zygloric`, `Fenormulator`) with
  and without the bias list

So the phrase-count limit question is moot: no size produced any change.

Confirmed against a real 45s human recording: still byte-identical. The result is
solid — it is just specific to `SpeechTranscriber`, which is why it initially
looked like the API was inert. See finding 1.

### 2. `fastResults` is a modest latency win

On a 9.1s sample, warm:

| config | first result | first final | volatile results |
|---|---|---|---|
| default | ~75-84ms | ~280-294ms | 41 |
| `.fastResults` | ~65-66ms | ~308-310ms | 44 |

Roughly 15% off first-token latency and slightly more frequent volatile updates,
at the cost of a marginally later finalization. Worth having behind a setting;
not transformative.

### 3. The model does not produce code identifiers

It transcribes spoken identifiers as ordinary words, and misrecognises some:

> Update the **work, tree path**, and check **created it** before you read the
> environment ID from the thread ref, then called child process **spunner** and
> map **area** over the file system layer.

(`worktreePath` → "work, tree path", `createdAt` → "created it", `spawner` →
"spunner", `mapError` → "map area".)

No configuration tested changed this. **LLM post-processing is therefore the only
available lever for code-identifier accuracy, not a nice-to-have.**

### 4. Denied microphone access is silent, not an error

Worth designing around: with no grant, `AVAudioEngine` produces a full-length
recording of digital silence and every API reports success. Nothing distinguishes
it from a user who said nothing. The real feature needs an explicit
`AVCaptureDevice.authorizationStatus` check plus a signal-level check, or users
hit "dictation does nothing" with no diagnosable cause.

### 5. LLM post-processing beats ASR biasing — and picks the engine

`clean` runs a raw transcript through a cleanup pass. Same 20-term vocabulary,
same prompt, two different ASR outputs as input:

| ASR input | post-processed result |
|---|---|
| `DictationTranscriber` + contextualStrings | "…needs a ProviderInstanceId **at the end of** workspaceRoot, useCallback and useMemo **both the** modelSelection, a runtimeMode check createdAt… review the **snoop** before **Cotric** ships" |
| `SpeechTranscriber` (no biasing) | "…needs a ProviderInstanceId **in the** workspaceRoot. useCallback and useMemo **both depend on** modelSelection and runtimeMode. Check createdAt… review the **Fnorbulator** before **Quastrix** ships." |

**`SpeechTranscriber` + LLM wins, decisively.** Three structural reasons, none
of them stylistic:

1. `DictationTranscriber` dropped "depend on" during recognition. No
   post-processor can restore words that were never transcribed.
2. `SpeechTranscriber`'s sentence boundaries survived; the run-on did not.
3. `SpeechTranscriber`'s "finobulator"/"quadric" retained enough phonetic
   information for the LLM to match against the vocabulary and recover
   `Fnorbulator`/`Quastrix`. `DictationTranscriber`'s "snoop"/"Cotric" had
   destroyed it — biasing made the acoustics *worse* on exactly the words it was
   supposed to help.

The LLM recovers what biasing missed anyway: "free ID" → `threadId`, "Fred ref" →
`threadRef`, "use me" → `useMemo`, "created that" → `createdAt`, "provider at the
end of" → `ProviderInstanceId`.

**So contextualStrings is not needed.** Use the better acoustic model and let the
LLM do the vocabulary work. That also makes finding 1 moot — `SpeechTranscriber`
ignoring contextualStrings no longer costs us anything.

Only `Zyglorp` → "as I go up" survives in both. Acoustically unrecoverable.

### 5a. Model matters for quality; CLI latency is not model-driven

The first latency pass was invalid — it used each CLI's configured default, which
is the heaviest option available (`claude` → `opus[1m]`, `codex` →
`gpt-5.6-terra` at `xhigh` reasoning). Always pin `--model`.

Quality, scored on recovering `threadId`, `threadRef`, `Fnorbulator`, `Quastrix`:

| model | recovery | wall |
|---|---|---|
| Opus 5 (`opus[1m]`) | all four | 4.9s |
| Sonnet 5 | all four | 5.5s |
| Haiku 4.5 | **none** | 67s, then 104s |
| GPT-5.6 Terra, xhigh | all four | 8.3s |
| GPT-5.6 Terra, low | all four | 19s |
| Apple on-device | **none** — returned input verbatim | 4.0s cold, **1.55s prewarmed** |

Two conclusions:

**The task needs a mid-tier model.** Haiku 4.5 left "Fred ID" and "finobulator"
untouched. Sonnet 5 matched Opus exactly, so there is no reason to pay for Opus.

**CLI latency is dominated by harness overhead, not inference.** Haiku was 20x
slower than Sonnet, and Terra at `low` reasoning was slower than the same model at
`xhigh`. Those orderings are incoherent as inference times. Model choice barely
predicts CLI wall time, and the variance (5s to 104s on identical input) is fatal
for an interactive feature.

The on-device model is the only predictable figure, and `prewarm` more than halves
it — 510ms of warmup that can happen *while the user is still speaking*, leaving
~1.5s after speech ends. But it did not perform the substitution at all, returning
the transcript verbatim. The instruction set (six rules plus an injection guard) is
likely too much for a small model.

Five seconds is far too slow to block on, confirming show-raw-immediately then
swap in the cleaned version. It also means post-processing quality, not ASR
speed, owns the entire latency budget — transcription itself is ~0.03 RTF.

Caveat: n=1 sample. The latency figures are indicative only, but the quality
differences are structural rather than stylistic, so the reasoning holds.

### 6. The on-device model works, but only on one utterance at a time

`t3-dictate probe` walks from trivial to the full task. `probe-guided` repeats the
failing case with guided generation.

| probe | ms | result |
|---|---|---|
| reply "OK" | 380 | correct |
| upper-case "hello world" | 182 | correct |
| replace "map error" → mapError | 257 | **"I'm sorry, but I cannot assist with that request."** |
| vocab substitution, 1 sentence, 3 terms | **259** | **perfect** — "call mapError on the FileSystem layer and then check the exitCode" |
| filler removal, 1 sentence | 373 | correct text, wrapped in "Sure, here is the corrected text:" |
| vocab substitution, 2 sentences, 17 terms | 3083 | **hallucinated a Python program** |
| …same, guided generation | 856 | input returned verbatim, no substitution |
| …short input, guided generation | 467 | input returned verbatim, no substitution |

The model is genuinely capable of the exact task — one sentence, small
vocabulary, free-form output, 259ms. That is ~20x faster than any CLI.

It is also unreliable in three distinct ways: spurious refusals on innocuous
input (and `Guardrails.permissiveContentTransformations` does **not** fix them),
conversational preamble, and complete derailment once the input grows to two
sentences. Guided generation via a `@Generable` struct stops the derailment but
suppresses the transformation entirely — it trades "wrong" for "does nothing".

**Design consequence:** feed it one finalized utterance at a time, never a whole
transcript. That is also what `SpeechTranscriber` naturally emits, so cleanup
pipelines during speech — by the time the user stops talking, every segment but
the last is already done, leaving a ~260ms tail.

Non-negotiable given the failure modes: validate the output (length ratio against
the input, reject code fences and known refusal strings) and fall back to the raw
segment. Never show model output unchecked.

### 7. The per-utterance pipeline fails on quality, not latency

`t3-dictate pipeline` runs audio → `SpeechTranscriber` → per-sentence on-device
cleanup → assembled text. Latency is a solved problem; quality is not.

Timings on the 45s recording: transcription 905ms, cleanup 2570ms across 6
segments, **slowest single segment 879ms**. Since every segment but the last is
cleaned while the user is still speaking, the perceived tail is under a second.

The output is worse than useless:

| segment | before | after |
|---|---|---|
| 1 | "…read the Fred ID from the Fredreff call map error…" | `worktreePath`, `FileSystem`, `exitCode` fixed; `threadId`, `threadRef`, `mapError` missed |
| 2 | "The child process phone needs a provider instance ID in the workspace route." | `ProviderInstanceId` fixed; `ChildProcessSpawner`, `workspaceRoot` missed |
| 3 | "Use callback and use member, both depend on model selection and runtime mode." | **unchanged** — missed all four |
| 4 | "Check created that and updated that on the environment ID…" | **unchanged** — missed all four |
| 5 | "…review the finobulator before quadric ships." | **"review the Zyglorp"** — substituted the wrong identifier |
| 6 | "…near the riverbank." | **"near the \*\*worktreePath\*\*"** — corrupted correct text, and added markdown |

Roughly 4 of 17 identifiers recovered, against near-perfect recovery from Sonnet 5
on the whole transcript. Worse, segments 5 and 6 are actively destructive:
segment 6 damaged a sentence that was already correct.

**The validator accepted all six.** Length ratio and refusal-marker checks cannot
detect "replaced a correct word with a plausible identifier". Output validation of
this kind is not sufficient protection.

The likely cause is vocabulary size: probe 4 was perfect with **3** terms, and this
run passed **20**. Same dilution effect seen with contextualStrings — but here the
failure mode is hallucination rather than no-op.

**Consequence:** do not put a small model in charge of choosing which identifier
applies. Shortlist candidates deterministically (fuzzy-match each segment against
the vocabulary, 2-5 candidates), and at that point the substitution itself is
deterministic too — no model needed for identifiers. Leave the model, if used at
all, to filler words and punctuation, where a mistake is cosmetic.

### 8. A deterministic matcher beats the on-device model outright

`t3-dictate match` expands each identifier to its spoken form (`worktreePath` →
"worktree path"), then scans token windows for fuzzy matches using Levenshtein
similarity with spaces stripped — so "work tree" and "worktree" are equivalent,
which is exactly the split the speech model keeps introducing.

At threshold 0.70, on the same fixture, in **4.2ms** (release build):

| approach | recovered | corruptions | time |
|---|---|---|---|
| on-device model, per segment | 4 / 20 | **2** | 2570ms |
| matcher @ 0.70 | **15 / 20** | **0** | **4.2ms** |
| Sonnet 5, whole transcript | 19 / 20 | 0 | ~5000ms |

Recovered: `worktreePath`, `mapError`, `FileSystem`, `exitCode`,
`ChildProcessSpawner`, `ProviderInstanceId`, `workspaceRoot`, `useCallback`,
`modelSelection`, `runtimeMode`, `createdAt`, `updatedAt`, `environmentId`,
`flatMap`, `Fnorbulator`.

Missed: `threadId` ("Fred ID"), `threadRef` ("Fredreff"), `useMemo` ("use
member"), `Quastrix` ("quadric"), `Zyglorp` ("as I go up") — all cases where the
phonetic distance is genuinely large.

The control sentence is untouched at every threshold. **The matcher cannot corrupt
text it does not match**, which is the property the model failed to provide.

Two bugs found and fixed while building it, both worth keeping in mind:

- **Window swallowing.** Length-normalised similarity lets an extra short token
  slide in almost free: "map error on" scores 0.80 against `mapError`, "Update
  the" scores 0.78 against `updatedAt`, and "a provider instance" matched
  `ProviderInstanceId` leaving a stray "ID". Fixed with a stopword guard on window
  boundaries, plus scoring every window size and taking the best rather than the
  longest.
- **"at" and "that" must not be stopwords.** Speech renders `createdAt` as
  "created at" or "created that", so those words are load-bearing.

Threshold choice: 0.70 gives zero false positives. 0.65 additionally recovers
`useMemo` but starts matching "Update" → `updatedAt` at a sentence start. Prefer
the conservative setting — the residue is precisely what an optional LLM pass can
mop up, and a matcher that stays silent is safe in a way a hallucinating model is
not.

**Recommended shape:** matcher first for an instant, zero-risk result; optional
LLM pass afterwards for the residue. The matcher also improves the LLM's input,
since fewer errors remain to confuse it.

### 9. Measured against a real corpus

24 recorded items, ~5.5 minutes: 14 `CODE` (identifiers spoken naturally), 6
`PROSE` negative controls, 4 free-form. `t3-dictate eval` transcribes each,
applies the matcher, and scores recall on identifiers plus false positives on
controls. Transcripts are cached, so threshold sweeps do not re-run ASR.

**The ASR is not the bottleneck.** Transcripts were largely correct — "Check if
the list is empty before you call on click", "The HTTP client needs the user ID
and the API URL". The failures were the matcher's.

Fixing the two structural defects (acronym word-splitting, stopword-prefix
waiver) moved recall from 45% to 76%:

| acceptance rule | recall | false positives | items damaged |
|---|---|---|---|
| ratio 0.60 | 86% (25/29) | 18 | 9 / 24 |
| ratio 0.65 | 83% (24/29) | 11 | 7 / 24 |
| ratio 0.70 | 76% (22/29) | 6 | 5 / 24 |
| ratio 0.80 | 69% (20/29) | 2 | 2 / 24 |
| **edit budget** | **69% (20/29)** | **2** | **2 / 24** |

The edit budget (≤8 chars → 1 edit, 9-14 → 2, 15+ → 3, minus one when the window
has fewer words than the identifier) reaches the same operating point as ratio
0.80 but is **threshold-insensitive** — identical results from 0.50 to 0.70. That
removes a tuning knob rather than requiring it to be re-tuned per vocabulary, and
is the reason to prefer it despite matching on raw numbers.

It also kills the specific failure the ratio metric could not: "change" and
"exchange" both scored exactly 0.75 against `onChange` (two edits on an
8-character candidate), so no ratio threshold separated them from real matches.

**The two remaining false positives are irreducible:**

```
[prose] "the room is empty so please turn the lights on"  -> isEmpty
[prose] "it is valid to change your mind before the deadline" -> isValid
```

Both score 1.0 — the spoken form of the identifier and the English phrase are
*identical*. No metric can distinguish them, which confirms this needs UI
(marked substitutions, one-tap revert) rather than a better score.

Caveat: one speaker, one accent, one session. These numbers do not transfer to
other users without re-measuring.

### 10. Hardening

All defects from the Oracle review and the adversarial probe are fixed, with no
change to corpus scores (69% recall, 2 false positives).

| defect | fix |
|---|---|
| acronyms unmatchable (`HTTPClient` → "h t t p client", 5 words) | `spokenWords` keeps consecutive capitals as one word |
| stopword-prefixed identifiers unmatchable (`isEmpty`, `onClick`, `forEach`) | boundary guard waived when the candidate's own spoken form starts/ends with that word |
| matched across sentence boundaries ("exit. The code" → `exitCode`) | a window may not extend past a token carrying trailing punctuation |
| interior function words absorbed ("map the error" → `mapError`) | edit budget rejects the extra token |
| leading punctuation deleted (`(work tree path)` → `worktreePath)`) | tokens keep leading punctuation; substitution re-emits it |
| newlines fused tokens into `codethe` | matching runs per line, preserving structure |
| ties resolved by vocabulary order (`getUser`/`getUsers`) | 0.05 margin over the runner-up, else no substitution |

Verification cases now passing:

```
in : I need to map the error message to a file system path before I exit.
     The code count is high so filter the results.
out: I need to map the error message to a FileSystem path before I exit.
     The code count is high so filter the results.

in : wrap the work tree path (and the exit code) in parens\nthen check the file system
out: wrap the worktreePath (and the exitCode) in parens\nthen check the FileSystem

in : call get user and then get users
out: call getUser and then getUsers
```

"a file system path" → `FileSystem` remains, and is the irreducible case: the
speaker meant ordinary English. Only context or the user's own eye resolves it.

### 11. Microphone quality dominates

Same speaker, same script, MacBook built-in mic instead of a ModMic:

| | recall | false positives |
|---|---|---|
| ModMic (24-item corpus) | 69% | 2 |
| MacBook mic (2-item corpus) | 64% | 3 |

The transcripts degraded far more than the scores suggest — `parseURL` → "partial
RL", `toJSON` → "a 2 J song", `HTTPClient` → "HTTP kite", `mapError` → "my error",
`base64Encode` → "base 64 and code output". Those are unrecoverable; the phonetic
content is gone.

That recall only fell 5 points on substantially worse input suggests the matcher
degrades gracefully. The ASR does not.

**Product consequence:** dictation quality varies significantly by input device
and is outside our control. A laptop mic in a noisy room will produce visibly
worse results than a headset, and no matcher work closes that gap.

**A third false-positive class appeared, and it is not a phrase collision.** The
control sentence "click **through** each item" was transcribed "click **for** each
item", and the matcher then correctly matched "for each" → `forEach`. The ASR
invented a collision that was never spoken. Distinct from `isEmpty`/`isValid`,
where identifier and English are genuinely identical — but the same mitigation
applies, because neither is detectable from the text alone.

Incidentally this validated the punctuation rule beyond its original purpose: the
ASR rendered "I called exit. The code path" as "I called exit**,** the code path",
and blocking windows that span *any* trailing punctuation still refused
`exitCode`. A sentence-boundary-only rule would have missed it.

### 12. Vocabulary must be scoped tightly — repo-scale is unusable

Every earlier measurement used a curated 29-term vocabulary containing exactly the
identifiers being spoken. Realistically the vocabulary comes from the repo. Same
corpus, same matcher, increasing numbers of irrelevant repo symbols mixed in:

| distractors | vocabulary | recall | false positives | items damaged |
|---|---|---|---|---|
| 0 | 29 | 69% | 2 | 2 / 24 |
| 100 | 129 | 62% | 3 | 3 / 24 |
| 500 | 529 | 52% | 10 | 8 / 24 |
| 3000 | 3011 | 52% | 15 | 9 / 24 |

Vocabulary size hurts **both** metrics. Recall falls because distractors win
matches the correct identifier should have taken; false positives rise because
with enough candidates, any two-word phrase lands within edit distance of
something.

At repo scale more than a third of utterances are damaged. The failures are
ordinary English colliding with real symbols:

```
"and then"    -> andThen      pure English; andThen is an Effect-TS combinator
"is fast"     -> isLast       silent, plausible, and semantically wrong
"work in."    -> forkIn
"device tree" -> deviceType
```

Caveat: free-form items have no ground truth, so every substitution counts as
damage. Some were arguably right — "color scheme" → `colorScheme`, "input field"
→ `inputField` are real symbols and the speaker was discussing them. True damage
is somewhere between 8 and 15; the trend is unaffected.

**Design consequence:** scope the vocabulary to what the user is actually working
on — symbols from `@file` mentions in the composer, the current thread, recently
edited files — and keep it around **100 terms**. 129 terms still scored 62% / 3 FP;
529 was already broken. Never feed it a whole-repo symbol extract.

This also inverts finding 8's advice about which terms to include. At 29 terms,
dropping function-word-initial identifiers cost more recall than it saved. At repo
scale the same class (`andThen`, `isLast`) causes the worst damage. Inclusion
policy has to depend on vocabulary size, not be fixed.

### 13. Parakeet beats Apple decisively — engine recommendation reversed

Handy (`com.incognitojam.handy-duck`) stores its transcripts in a SQLite
`history.db` beside the source wavs, so the same audio could be scored through a
second engine at no cost. Handy was running
`parakeet-unified-en-0.6b-Q8_0.gguf` — NVIDIA Parakeet TDT 0.6B, quantised.

Same recordings, same matcher, same vocabulary:

| recording | Apple `SpeechTranscriber` | Parakeet 0.6B |
|---|---|---|
| ModMic | 82% (18/22), 2 FP | **95% (21/22)**, 2 FP |
| MacBook, quiet | 77% (17/22), 1 FP | **95% (21/22)**, 2 FP |
| MacBook, fan noise | 64% (14/22), 3 FP | **95% (21/22)**, 2 FP |

**Parakeet is unaffected by the audio quality that moved Apple 18 points.** That
matters more than the headline accuracy: most users dictate on laptop mics in
imperfect rooms, and finding 11 established we cannot control that.

Word-level comparison on identical audio:

| target | Parakeet | Apple |
|---|---|---|
| `parseURL` | "parse URL" | "part u r l" |
| `apiUrl` | "API URL" | "a p I, URL" |
| `toJSON` | "to JSON" | "to j salt" |
| `threadId` | "thread ID" | "Fred ID" |
| `workspaceRoot` | "workspace root" | "workspace route" |
| `mapError` | `mapError` | "map error" |

Parakeet emits some identifiers already camelCased, so its training data clearly
includes code.

**The matcher is still load-bearing.** Raw Parakeet transcripts contain only 2 of
25 identifiers verbatim — it supplies cleaner words, and the matcher converts them.
The layered design holds; only the engine choice changes.

Trade-offs this reverses, and what it costs:

- Apple: zero bytes shipped, OS-managed models, native streaming with volatile
  results, 30 locales, macOS 26+ only. 64-82% and noise-sensitive.
- Parakeet: ~600MB model to download, a native runtime to package and sign,
  English-only in this build. Cross-platform, noise-robust, 95%.

Handy demonstrates the packaging is tractable. Open question: whether the
streaming/volatile-results UX survives the switch — Apple's API provides it
natively, and a GGUF batch pipeline may not.

Caveat: one speaker, English, three recordings. Parakeet also ran through Handy's
own VAD preprocessing, which is not controlled for.

### 14. Server-side streaming works; transport is not the bottleneck

`parakeet-sidecar/` is a Rust binary: 16 kHz mono f32 PCM on stdin, JSONL
`{committed, tentative}` on stdout. `server.mjs` is a stand-in for the T3
endpoint (raw HTTP, chunked NDJSON response); `client.mjs` streams a wav at
real-time pace and measures what a user would feel.

**`transcribe-cpp` streams fine from a spawned process** — `supportsStreaming:
true`, Metal backend, 36 incremental updates over a 38.7s utterance. It is not
restricted to Handy's in-process use.

| | localhost | via Tailscale interface |
|---|---|---|
| tail (stop talking → final text) | **153ms** | **120ms** |
| first text | 2116ms | 2268ms |
| updates | 36 | 36 |

Tailscale overhead is indistinguishable from noise. At 64 kB/s the transport is
trivial, and because frames pipeline, network RTT adds to the tail roughly once
rather than per chunk — a 50ms RTT should land the tail near 200ms.

Caveat: both endpoints were this machine, so no genuine WAN hop was tested. Only
one tailnet peer was online.

**Two operational constraints this surfaces:**

1. **Model load is 10.7s.** A sidecar must be kept warm; spawning per utterance
   is not viable. `server.mjs` pre-spawns one and replaces it after each request.
2. **Streaming does nothing for short utterances.** A 3.6s clip produced a single
   update at 3198ms — effectively at the end. Parakeet commits on roughly 2s
   boundaries, so live text only appears for longer dictation. The bubble still
   earns its place as a "you are being heard" indicator, but live text is not the
   selling point for brief commands.

Throughput was 0.09 RTF on Metal. A headless Linux server without a GPU will be
slower; it needs to stay under 1.0 RTF to keep up with live audio, which is
untested and is the main remaining risk for server-side deployment.

Also observed: Parakeet emits identifiers camelCased natively here too —
"Make sure isValid passes before onChangeFiles" (`onChange fires` misheard, but
`isValid` and `onChange` produced directly).

### 15. Phrase collisions are deterministic, not probabilistic

The `PROSE` control read by six `say` voices across five English locales
(`Daniel` en_GB, `Karen` en_AU, `Moira` en_IE, `Rishi` en_IN, `Samantha` and
`Tessa` en_US), transcribed with Parakeet and run through the matcher:

| voice | substitutions |
|---|---|
| all six | `isEmpty`, `isValid` |

Transcripts were byte-identical too. Since the matcher is deterministic, this
follows necessarily: whenever the ASR transcribes "the room is empty" correctly,
`isEmpty` *must* be substituted.

**So the rate of this false-positive class equals the probability the ASR
transcribes the phrase faithfully.** As transcription accuracy improves, this
class approaches 100%. It cannot be engineered away in the text layer, and better
microphones make it worse — confirming finding 11 by argument rather than
observation.

Synthetic audio is valid here specifically because the collision happens after
transcription. It says nothing about recall on `CODE` items, where TTS would
pronounce `isEmpty` as an invented word rather than the way a person says it —
that still needs human speakers.

### 16. Second speaker — the numbers generalise

An independent contributor recorded `corpus-remote.txt` (two mp3s, sent remotely
with no tooling on their side — `RECORDING.md` plus `t3-dictate import`).

| speaker | Apple | Parakeet |
|---|---|---|
| Cameron, ModMic | 82% | 95% |
| Cameron, MacBook quiet | 77% | 95% |
| Cameron, MacBook + fan | 64% | 95% |
| **Second speaker** | **73%** | **91%** |

Parakeet holds at 91% on a voice it was never tuned against, and the engine gap
holds at 18 points. The headline numbers were not fitted to one speaker.

**Finding 15 confirmed independently.** Both predicted phrase collisions fired —
including `isValid` from "**It's** valid", a contraction, in the Apple run.

Parakeet's two misses were both the matcher *refusing* rather than failing:

- `isValid` — transcribed "confirm the value **as** valid". "as" is a boundary
  stopword that is not the identifier's first word, so the waiver correctly did
  not apply.
- `thread_id` — the vocabulary contains both `threadId` and `thread_id`, whose
  spoken forms are identical. The 0.05 ambiguity margin refused to guess.

The second is the Oracle's "dedupe spoken-form collisions" advice arriving as a
live case. **Vocabulary construction should collapse identifiers sharing a spoken
form**, choosing by frequency or recency, rather than leaving the margin to
suppress both.

Parakeet again emitted identifiers directly: `WorktreePath`, `mapError`,
`base64`. Casing was not always canonical, which the matcher normalises.

### 17. CPU-only throughput — fine for one user, marginal beyond

`parakeet-sidecar --cpu` forces the ggml CPU path, which is the same code a
GPU-less Linux server would run. Apple M3 Pro, 12 cores, 38.7s utterance:

| configuration | RTF | headroom vs live audio |
|---|---|---|
| Metal | 0.18 | 5.5x |
| CPU, single stream | **0.389** | 2.6x |
| CPU, 3 concurrent | 0.891 / 1.056 / 1.056 | **at or past the limit** |

RTF must stay under 1.0 to keep pace with live audio. A single CPU stream has
comfortable headroom; three concurrent streams saturate the machine.

What this does and does not settle:

- **The common deployment is fine.** T3's server usually runs on the user's own
  development machine serving one person. CPU-only at 0.389 is ample, and no GPU
  is required.
- **Small servers are not covered.** A 2-4 vCPU VPS could plausibly be 3-5x
  slower than this, putting a single stream past 1.0. Untested.
- **Multi-user needs a GPU** or generous cores. Roughly 2-3 concurrent streams
  saturate a 12-core CPU.

Model load was **10.7s cold** but **0.5-0.7s** once the file is in page cache, so
the earlier figure was dominated by first disk read. A warm process is still
wanted for the first utterance after boot, but the steady-state cost is small.

### Incidental

- Analyzer format is 16kHz mono float32.
- Transcription runs at ~0.03-0.05 realtime factor (9.1s of audio in ~285ms), so
  the ASR is not the latency bottleneck — post-processing will be.
- `AssetInventory.status` reported `supported` rather than `installed` for a
  locale that was in `installedLocales` and transcribed fine, and
  `assetInstallationRequest` returned nil. Don't gate startup on that status.
