import type {
  ProviderAuthInteraction,
  ProviderInstanceId,
  ProviderSetupError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";

import { forwardLoopbackCallback } from "./loopbackCallback.ts";

import type { ProviderAuthFlowContext } from "./providerAuthFlow.ts";

const MAX_TRANSCRIPT_LENGTH = 16_384;
const CODE_FIELD = "code";
const TERMINAL_SETTLE = "300 millis";

const plainText = (output: string) =>
  output.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g, "");

/**
 * The latest web link a login printed. Phones have no terminal to click in, and terminals only
 * soft-wrap the URL, so the raw output holds it whole.
 */
export const latestLoginUrl = (output: string): string | undefined => {
  const matches = plainText(output).match(/https?:\/\/[^\s"'<>\u2500-\u257f]+/g);
  const latest = matches?.at(-1);
  return latest === undefined || latest.length > MAX_TRANSCRIPT_LENGTH ? undefined : latest;
};

const loopbackRedirect = (authorizeUrl: string): URL | undefined => {
  try {
    const redirect = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri") ?? "");
    return redirect.protocol === "http:" &&
      (redirect.hostname === "127.0.0.1" || redirect.hostname === "localhost")
      ? redirect
      : undefined;
  } catch {
    return undefined;
  }
};

export type LoginPrompt =
  | { readonly type: "pasteCode"; readonly url: string }
  | { readonly type: "deviceCode"; readonly url: string; readonly userCode: string }
  | { readonly type: "redirect"; readonly url: string; readonly redirect: URL };

/**
 * What a login's output is asking for, read from what it prints because these CLIs have no
 * machine-readable mode. Anything unrecognized returns null and stays in the terminal.
 */
export const readLoginPrompt = (output: string): LoginPrompt | null => {
  const url = latestLoginUrl(output);
  if (url === undefined) return null;
  const plain = plainText(output);
  if (/paste (?:the |your )?code/i.test(plain)) return { type: "pasteCode", url };
  for (const line of plain.split(/\r?\n/)) {
    if (line.includes("://")) continue;
    const userCode = /\bcode\b[^:\n]*:\s*([A-Z0-9]{2,}(?:-[A-Z0-9]{2,})+|[A-Z0-9]{6,})\b/.exec(
      line,
    )?.[1];
    if (userCode !== undefined) return { type: "deviceCode", url, userCode };
  }
  const redirect = loopbackRedirect(url);
  return redirect === undefined ? null : { type: "redirect", url, redirect };
};

/** A pasted redirect must come from this sign-in: the listener it names, and its `state`. */
export const parsePastedRedirect = (
  pasted: string,
  prompt: Extract<LoginPrompt, { readonly type: "redirect" }>,
): URL | null => {
  let callback: URL;
  try {
    callback = new URL(pasted.trim());
  } catch {
    return null;
  }
  const state = new URL(prompt.url).searchParams.get("state");
  return callback.origin === prompt.redirect.origin &&
    callback.pathname === prompt.redirect.pathname &&
    (state === null || callback.searchParams.get("state") === state)
    ? callback
    : null;
};

/** Runs a login command until it exits, showing a form when its prompt is recognized. */
export const run: (input: {
  readonly pty: PtyAdapter.PtyAdapter["Service"];
  readonly instanceId: ProviderInstanceId;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly context: ProviderAuthFlowContext;
  readonly failure: (operation: string, detail: string, cause?: unknown) => ProviderSetupError;
  /** Shown above the command's own output, in every client. */
  readonly hint?: string;
  /** Recognize prompts. Without it the login always stays in the terminal. */
  readonly readPrompts?: boolean;
  /** How long output must pause before it counts as unrecognized. */
  readonly settle?: Effect.Effect<void>;
}) => Effect.Effect<void, ProviderSetupError, Scope.Scope> = Effect.fnUntraced(function* (input) {
  const exited = yield* Deferred.make<number>();
  const output = yield* Queue.sliding<string>(64);
  const process = yield* input.pty
    .spawn({
      shell: input.command,
      args: [...input.args],
      cwd: input.cwd,
      cols: 80,
      rows: 24,
      env: input.env,
    })
    .pipe(
      Effect.mapError((cause) =>
        input.failure("start", "Could not open the provider sign-in terminal.", cause),
      ),
    );
  const detachData = process.onData((data) => {
    Queue.offerUnsafe(output, data.slice(-MAX_TRANSCRIPT_LENGTH));
  });
  const detachExit = process.onExit(({ exitCode }) => {
    Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      detachData();
      detachExit();
      try {
        process.kill();
      } catch {}
    }),
  );
  let transcript = input.hint === undefined ? "" : `${input.hint}\r\n\r\n`;
  let outputOffset = transcript.length;
  let url: string | undefined;
  // Output since the user last typed: a prompt read from before that has already been answered.
  let segment = "";
  let submissions = 0;
  let checkingCode = false;
  let shown = "";
  let terminalShown = false;
  let terminalGeneration = 0;
  const writeToLogin = (data: string) =>
    Effect.try({
      try: () => process.write(data),
      catch: () =>
        input.failure("respond", "The provider sign-in terminal is no longer available."),
    });
  const showTerminal = () =>
    input.context.setInteraction(
      {
        type: "terminal",
        id: "terminal",
        output: transcript,
        outputOffset,
        ...(url === undefined ? {} : { url }),
      },
      (response) =>
        response.type === "terminal"
          ? Effect.try({
              try: () => {
                if (response.size) process.resize(response.size.cols, response.size.rows);
                if (response.data) {
                  segment = "";
                  shown = "";
                  process.write(response.data);
                }
              },
              catch: () =>
                input.failure("respond", "The provider sign-in terminal is no longer available."),
            })
          : Effect.void,
    );
  const showCodeForm = (promptUrl: string, rejected: boolean) => {
    const interaction: ProviderAuthInteraction = {
      type: "credentials",
      id: `code-${submissions}`,
      url: promptUrl,
      fields: [
        {
          name: CODE_FIELD,
          label: rejected
            ? "That code was not accepted. Paste the full code."
            : "Code from the sign-in page",
          secret: true,
        },
      ],
    };
    return input.context.setInteraction(interaction, (response) =>
      response.type === "credentials"
        ? Effect.gen(function* () {
            const code = response.values[CODE_FIELD]?.trim();
            if (!code) return yield* input.failure("respond", "Paste the code first.");
            submissions++;
            segment = "";
            shown = "";
            checkingCode = true;
            yield* input.context.verifying;
            yield* writeToLogin(`${code}\r`);
          })
        : Effect.void,
    );
  };
  const showPrompt = (prompt: LoginPrompt): Effect.Effect<void> => {
    switch (prompt.type) {
      case "pasteCode":
        return showCodeForm(prompt.url, false);
      case "deviceCode":
        return input.context.setInteraction({
          type: "deviceCode",
          id: "device-code",
          url: prompt.url,
          userCode: prompt.userCode,
        });
      case "redirect":
        return input.context.setInteraction(
          {
            type: "browser",
            id: "browser",
            url: prompt.url,
            requiresConsent: false,
            acceptsCallback: true,
          },
          undefined,
          (pasted) => {
            const callback = parsePastedRedirect(pasted, prompt);
            return callback === null
              ? input.failure("complete", "This URL does not belong to the current sign-in.")
              : forwardLoopbackCallback(input.instanceId, callback);
          },
        );
    }
  };
  // Output arrives in chunks; wait for a prompt to finish printing before showing raw output.
  const showTerminalSoon = (): Effect.Effect<void, never, Scope.Scope> => {
    if (terminalShown) return showTerminal();
    const generation = ++terminalGeneration;
    return (input.settle ?? Effect.sleep(TERMINAL_SETTLE)).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (generation !== terminalGeneration) return Effect.void;
          terminalShown = true;
          return showTerminal();
        }),
      ),
      Effect.forkScoped,
      Effect.asVoid,
    );
  };
  const update = (): Effect.Effect<void, never, Scope.Scope> => {
    if (input.readPrompts !== true) return showTerminal();
    if (segment.length === 0 && !checkingCode) {
      return input.hint === undefined ? Effect.void : showTerminalSoon();
    }
    if (checkingCode) {
      const answer = plainText(segment).trim();
      if (answer.length === 0) return Effect.void;
      if (/success|logged in|signed in/i.test(answer)) return Effect.void;
      checkingCode = false;
      if (/invalid|incorrect|expired/i.test(answer) && url !== undefined) {
        shown = `rejected:${submissions}`;
        terminalGeneration++;
        terminalShown = false;
        return showCodeForm(url, true);
      }
      shown = "";
    }
    if (shown.startsWith("rejected:")) return Effect.void;
    const prompt = readLoginPrompt(segment);
    if (prompt === null) {
      shown = "";
      return showTerminalSoon();
    }
    terminalGeneration++;
    terminalShown = false;
    const key = JSON.stringify(prompt);
    if (key === shown) return Effect.void;
    shown = key;
    return showPrompt(prompt);
  };
  yield* update();
  yield* Queue.take(output).pipe(
    Effect.flatMap((data) => {
      outputOffset += data.length;
      transcript = (transcript + data).slice(-MAX_TRANSCRIPT_LENGTH);
      segment = (segment + data).slice(-MAX_TRANSCRIPT_LENGTH);
      url = latestLoginUrl(transcript) ?? url;
      return update();
    }),
    Effect.forever,
    Effect.forkScoped,
  );
  if ((yield* Deferred.await(exited)) !== 0)
    return yield* input.failure(
      "start",
      checkingCode
        ? "That code was not accepted. Start sign-in again and paste the full code."
        : "The provider login command did not finish successfully.",
    );
});
