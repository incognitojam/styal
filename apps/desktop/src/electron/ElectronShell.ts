import { MAC_PERMISSION_SETTINGS_URLS } from "../permissions/MacPermission.ts";
import {
  REMOTE_CAPABLE_EDITOR_IDS,
  remoteSchemeForEditor,
  type SystemSettingsPane,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

const SAFE_WEB_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

// Remote open-in-editor deep links (`vscode://vscode-remote/ssh-remote+…`,
// `zed://ssh/<host>/<path>`, `jetbrains://gateway/ssh/environment?h=…`) must
// reach the OS handler when requested by trusted T3 UI; every other non-web
// scheme stays blocked.
const REMOTE_EDITOR_PROTOCOLS = new Set(
  REMOTE_CAPABLE_EDITOR_IDS.flatMap((id) => {
    const scheme = remoteSchemeForEditor(id);
    return scheme === undefined ? [] : [`${scheme}:`];
  }),
);

// Zed embeds [user@]host in the path; reject passwords and ports there.
const ZED_SSH_PATHNAME = /^\/(?:[^/@:]+@)?[^/@:]+\/.*$/;

const isRemoteEditorUrl = (url: URL) =>
  REMOTE_EDITOR_PROTOCOLS.has(url.protocol) &&
  url.username.length === 0 &&
  url.password.length === 0 &&
  (url.protocol === "zed:"
    ? url.host === "ssh" && ZED_SSH_PATHNAME.test(url.pathname)
    : url.protocol === "jetbrains:"
      ? url.host === "gateway" &&
        url.pathname === "/ssh/environment" &&
        (url.searchParams.get("h") ?? "").length > 0
      : url.host === "vscode-remote" &&
        url.pathname.startsWith("/ssh-remote+") &&
        url.pathname.length > "/ssh-remote+".length);

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
    /** `bundleId` opens that app's own page where the pane has one. */
    readonly openSystemSettings: (
      pane: SystemSettingsPane,
      bundleId?: string,
    ) => Effect.Effect<boolean>;
    readonly copyText: (text: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronShell") {}

/** @public */
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
  openSystemSettings: (pane, bundleId) =>
    Effect.promise(() =>
      Electron.shell
        .openExternal(
          pane === "notifications" && bundleId
            ? `${MAC_PERMISSION_SETTINGS_URLS[pane]}?id=${encodeURIComponent(bundleId)}`
            : MAC_PERMISSION_SETTINGS_URLS[pane],
        )
        .then(
          () => true,
          () => false,
        ),
    ),
  copyText: (text) =>
    Effect.promise(() => Electron.clipboard.writeText(text).catch(() => undefined)),
});

export const layer = Layer.succeed(ElectronShell, make);
