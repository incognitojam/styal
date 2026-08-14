# Dictation

Speech-to-text into the composer. Audio never leaves the user's own machines.

Every decision below is backed by measurements in `native/dictation-spike/README.md`
(findings 1-14). The spike is throwaway; the findings are not.

## Architecture

```
apps/web  getUserMedia -> 16kHz mono f32 PCM
             │  raw HTTP POST, chunked
             ▼
apps/server /api/dictation/stream ──> warm Parakeet sidecar (stdin PCM)
             │                              │ JSONL {committed, tentative}
             │◀─────────────────────────────┘
             │  chunked NDJSON response
             ▼
apps/web  matcher (packages/shared) -> composer draft
```

Capture lives in `apps/web`, which covers desktop for free — the desktop renderer
*is* `apps/web`. Transcription lives on the server so web, desktop and eventually
mobile share one implementation, and because the T3 server is the user's own
machine, audio stays on their infrastructure.

**Engine:** Parakeet TDT 0.6B (GGUF, Q8_0) via the `transcribe-cpp` crate.
Measured 95% identifier recall against Apple `SpeechTranscriber`'s 64-82%, and
unaffected by microphone quality or background noise that moved Apple 18 points
(findings 11, 13). Streams from a spawned process (finding 14). No macOS, Tahoe or
Apple Intelligence dependency anywhere in the design.

**No ASR-level biasing.** `contextualStrings` is ignored by `SpeechTranscriber`;
Apple custom language models are ignored entirely, including a deliberately
corrupted model file (findings 1, 1b). Parakeet has no equivalent hook we need.
Identifier recovery happens after transcription.

## Phase 1 — server engine

**`native/dictation/`** — Rust sidecar, promoted from
`native/dictation-spike/parakeet-sidecar/`. PCM on stdin, JSONL on stdout. Clone
the `native/resource-monitor` pattern for build and packaging:

- staged via `DESKTOP_DICTATION_EXTRA_RESOURCES`, behind the `--dictation` flag
  (`T3CODE_DESKTOP_DICTATION`). Off by default: `transcribe-cpp` builds ggml from
  C++ for every target, only macOS arm64 has been proven, and nightly desktop
  builds should not pay that cost or risk until Windows and Linux are verified
- path resolution mirroring `resolveResourceMonitorPath`
  (`apps/desktop/src/backend/DesktopBackendConfiguration.ts:144-170`)
- cross-compile targets alongside `resolveResourceMonitorRustTargets` (`:98`)

**Model management.** ~600MB download on first use, not bundled. Needs a resolved
cache path, integrity check, progress reporting, and a settings surface showing
size and location.

**Warm sidecar lifecycle.** A `DictationEngine` service holding one warm process,
replaced after each utterance. Model load is 10.7s cold but 0.5-0.7s once the file
is in page cache (finding 17), so the warm process matters most for the first
utterance after boot. Needs an idle unload timeout (Handy uses 5 minutes) and a
cold-start path that reports "warming" rather than hanging.

No GPU is required — CPU-only runs at 0.389 RTF (finding 17) — but the engine
should measure its own RTF and warn as it approaches 1.0.

**`POST /api/dictation/stream`** — raw route in `apps/server/src/http.ts`,
alongside the OTLP proxy at `:165`, guarded by `authenticateRawRouteWithScope`.
Request body is a PCM stream via `request.stream`; response is chunked NDJSON.

Deliberately *not* the WebSocket RPC: `RpcSerialization.layerJson`
(`apps/server/src/ws.ts:2346`) would force base64, inflating 64 kB/s of PCM by a
third. The spike proved raw HTTP streaming end to end.

Client disconnect must kill the sidecar — no orphans.

**Exit criteria:** `native/dictation-spike/parakeet-sidecar/client.mjs` streams a
wav to the real endpoint and gets streaming text back, tail under ~300ms.

## Phase 2 — matcher

**`packages/shared/src/dictationMatcher.ts`** — port `Matcher.swift`. ~200 lines
of pure string logic, no platform dependencies, so it belongs in shared code and
the existing Vitest suite. Port faithfully; every rule below cost a measurement:

- spoken forms keep consecutive capitals as one word (`HTTPClient` -> "http
  client", not "h t t p client")
- boundary stopword guard, waived when the candidate's own spoken form starts or
  ends with that word (otherwise `isEmpty`, `onClick`, `forEach` are unmatchable)
- "at" and "that" are never boundary stopwords — speech renders `createdAt` as
  "created at" or "created that"
- length-banded edit budget (<=8 chars -> 1 edit, 9-14 -> 2, 15+ -> 3), minus one
  when the window has fewer words than the identifier. Threshold-insensitive from
  0.50-0.70, which removes a tuning knob
- windows never span a token carrying trailing punctuation
- matching runs per line; leading punctuation is preserved
- 0.05 margin over the runner-up, else no substitution

**Fixtures.** `native/dictation-spike/corpus*/NNN.transcript.txt` are small text
files — commit them as regression fixtures. The audio stays gitignored (46MB, and
personal voice data).

**Vocabulary scoping** — the highest-leverage decision in the feature. Target
**~100 terms** from files referenced in the composer, symbols in the current
thread, and recently edited files. Never a repo-wide extract: at 3000 terms recall
fell to 52% and 9 of 24 utterances were damaged, with "and then" -> `andThen` and
"is fast" -> `isLast` (finding 12).

**Collapse spoken-form collisions when building the vocabulary.** `threadId` and
`thread_id` share the spoken form "thread id", so the ambiguity margin suppresses
both and the identifier is lost (finding 16). Pick one per spoken form by
frequency or recency at construction time.

## Phase 3 — capture and composer

**Capture** in `apps/web`, modelled on `browser/browserRecording.ts` (the existing
`MediaRecorder` usage) but audio-only and streaming rather than buffered.
Resample to 16kHz mono f32, 100ms frames.

**Permissions.** macOS packaged builds need all three, or `getUserMedia` fails
silently — a denied mic yields a full-length recording of digital silence with no
error anywhere (finding 4):

- `NSMicrophoneUsageDescription` via a new `mac.extendInfo` block
  (`scripts/build-desktop-artifact.ts:1579` — no `extendInfo` exists today)
- `com.apple.security.device.audio-input` in `renderMacPasskeyEntitlements`
  (`:838`) — **split it so the entitlement is not signed-builds-only**, otherwise
  local dev and release diverge
- `setPermissionRequestHandler` granting `media` on the **default** session in
  `apps/desktop/src/window/DesktopWindow.ts`. Not `preview/BrowserSession.ts`,
  which deliberately withholds capabilities from untrusted content

Check `AVCaptureDevice.authorizationStatus` equivalent up front and verify signal
level, so "dictation does nothing" is diagnosable.

**Composer wiring:**

- mic button in the footer toolbar (`ChatComposer.tsx:3126-3210`), plus
  `composerFooterLayout.ts` and `CompactComposerControlsMenu.tsx` for the
  compact-width path
- `composer.dictate` in `STATIC_KEYBINDING_COMMANDS`
  (`packages/contracts/src/keybindings.ts`) — settings UI, conflict detection and
  palette hints all derive from it automatically. Push-to-talk default, toggle as
  a setting
- insertion through `applyPromptReplacement` (`ChatComposer.tsx:1588`), reached
  via `ComposerHandleContext` so no prop drilling. Use `expandedCursor` from
  `readSnapshot()` — `insertTextAtEnd` uses collapsed offsets and is only safe at
  the end
- insertion is refused while connecting, in approval state, or with pending
  inputs. On refusal, write to the composer stash and toast, following the
  convention at `ChatComposer.tsx:2461`

**Live bubble.** Extract `ComposerCommandMenuLayer` (`ChatComposer.tsx:129-175`),
which already tracks the composer's rect through resize, scroll and panel
animation. Volatile text renders here and **never** touches the draft store —
drafts persist to localStorage and revision-sync across devices, so streaming
partials into them would spam sync and pollute undo. Only finalized utterances
call `applyPromptReplacement`.

Temper expectations: a 3.6s utterance produced one update at 3198ms, effectively
at the end (finding 14). Live text only materialises for longer dictation; for
short commands the bubble is a "you are being heard" indicator.

**Settings** in `ClientSettingsSchema` + `ClientSettingsPatch`
(`packages/contracts/src/settings.ts`): enable, push-to-talk vs toggle, input
device, vocabulary on/off. Fold into General rather than adding a section.

## Phase 4 — marked substitutions

Every matcher substitution renders as a marked span with one-tap revert.

This is **not** polish. Three independent routes reached it: the Oracle review,
the on-device model's corruption of a correct sentence, and the corpus. Three
false-positive classes exist and none are detectable from text alone:

| class | example | why undetectable |
|---|---|---|
| phrase collision | "the room is empty" -> `isEmpty` | scores 1.0; genuinely identical |
| ASR-invented collision | "through each" heard as "for each" -> `forEach` | the text is a real match |
| ambiguous intent | "a file system path" -> `FileSystem` | depends what the user meant |

Output validation was tried and failed: a length-ratio and refusal-marker
validator accepted 6 of 6 segments including two corruptions (finding 7).

Counterintuitively, **better audio produces more of these** — collisions only
surface when the ASR transcribes the colliding words correctly. Hardware
improvements make this class more visible, not less.

This is deterministic, not a tendency. The prose control read by six `say` voices
across five English locales produced byte-identical transcripts and identical
substitutions (finding 15). Because the matcher is deterministic, the rate of this
class equals the probability the ASR transcribes the phrase faithfully — so it
approaches 100% as transcription improves. Phase 4 is therefore load-bearing, not
a refinement.

## Out of scope

- **LLM cleanup pass.** Optional polish. Sonnet 5 recovered 19/20 identifiers but
  costs ~5s with 5-104s variance through provider CLIs (finding 5a), and Handy
  ships without one. Revisit as a setting once the core works.
- **Apple on-device model.** Recovered 4/20 with 2 corruptions, hallucinated an
  entire Python program on a two-sentence input, and requires opt-in Apple
  Intelligence (findings 6, 7).
- **Mobile.** OS keyboard dictation covers it today. The server endpoint makes
  this straightforward later.
- **Windows/Linux packaging.** `transcribe-cpp` targets both; only the build
  matrix work is deferred.

## Risks

1. **Server CPU without a GPU.** Measured (finding 17): CPU-only is **0.389 RTF**
   single-stream on an M3 Pro, against 0.18 on Metal — comfortable for the common
   case of one user on their own machine, and no GPU required. But three
   concurrent streams reach ~1.0 and fall behind, and a small VPS could exceed 1.0
   on a single stream. So: fine for the primary deployment, unproven on low-power
   hosts, and multi-user needs a GPU or generous cores. Surface a warning when
   measured RTF approaches 1.0 rather than silently dropping audio.
2. ~~**One speaker.**~~ **Largely retired.** A second, independent speaker scored
   91% with Parakeet and 73% with Apple (finding 16) — within range, and the
   18-point engine gap held. Two speakers is still thin, but the numbers are no
   longer fitted to one voice. Both of Parakeet's misses were the matcher
   correctly refusing rather than failing.
3. **600MB download** on a feature the user may not want. Gate behind explicit
   opt-in; never download on app start.
4. **Warm sidecar memory** held indefinitely. Needs an idle timeout.
5. **Vocabulary scoping is unbuilt.** The ~100-term target is measured, but
   selecting *which* 100 from live composer context is new work with no data yet.

## Sequencing

Phase 1 and 2 are independent and both testable headlessly — the matcher against
committed transcripts, the engine against wav files. Phase 3 depends on both.
Phase 4 depends on 3.

Risk 1 should be settled before Phase 1 starts: run the sidecar on a
representative non-GPU Linux box and check RTF. If it exceeds 1.0, server-side
needs rethinking, and that invalidates a large part of this plan.
