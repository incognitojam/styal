import { REMOTE_CAPABLE_EDITOR_IDS, remoteSchemeForEditor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

const SAFE_WEB_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

// Remote open-in-editor deep links (`vscode://vscode-remote/ssh-remote+…`)
// must reach the OS handler when requested by trusted T3 UI; every other
// non-web scheme stays blocked.
const REMOTE_EDITOR_PROTOCOLS = new Set(
  REMOTE_CAPABLE_EDITOR_IDS.flatMap((id) => {
    const scheme = remoteSchemeForEditor(id);
    return scheme === undefined ? [] : [`${scheme}:`];
  }),
);

const isRemoteEditorUrl = (url: URL) =>
  REMOTE_EDITOR_PROTOCOLS.has(url.protocol) &&
  url.username.length === 0 &&
  url.password.length === 0 &&
  url.host === "vscode-remote" &&
  url.pathname.startsWith("/ssh-remote+") &&
  url.pathname.length > "/ssh-remote+".length;

function parseUrlWhen(rawUrl: unknown, isAllowed: (url: URL) => boolean): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    return isAllowed(url) ? Option.some(url.href) : Option.none();
  } catch {
    return Option.none();
  }
}

/** Restricts untrusted web content to URLs a system browser can handle. */
export function parseSafeWebExternalUrl(rawUrl: unknown): Option.Option<string> {
  return parseUrlWhen(rawUrl, (url) => SAFE_WEB_EXTERNAL_PROTOCOLS.has(url.protocol));
}

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  return parseUrlWhen(
    rawUrl,
    (url) => SAFE_WEB_EXTERNAL_PROTOCOLS.has(url.protocol) || isRemoteEditorUrl(url),
  );
}

export class ElectronShell extends Context.Service<
  ElectronShell,
  {
    readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
    readonly copyText: (text: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronShell") {}

export const make = ElectronShell.of({
  openExternal: (rawUrl) =>
    Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (externalUrl) =>
        Effect.promise(() =>
          Electron.shell.openExternal(externalUrl).then(
            () => true,
            () => false,
          ),
        ),
    }),
  copyText: (text) =>
    Effect.sync(() => {
      Electron.clipboard.writeText(text);
    }),
});

export const layer = Layer.succeed(ElectronShell, make);
