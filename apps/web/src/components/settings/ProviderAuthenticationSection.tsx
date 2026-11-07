import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderAuthRespondInput,
  ProviderAuthResponse,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { CopyIcon } from "lucide-react";

import { sharesMachineWithEnvironment } from "../../browser/browserTargetResolver";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { reportForkClientUsage } from "../../forkClientUsage";
import { ensureLocalApi } from "../../localApi";
import { applyMaskedEdit, maskCode } from "@t3tools/shared/maskedCode";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { DialogFooter, DialogPanel } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow } from "./settingsLayout";
import { RedactedSensitiveText } from "./RedactedSensitiveText";

const ProviderAuthTerminal = lazy(() => import("./ProviderAuthTerminal"));

// Outlives the component so reopening the dialog or settings row mid-sign-in opens no second tab.
let autoOpenedFlowId: string | null = null;

export function ProviderAuthenticationSection({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  readOnly,
  usageEntryPoint = "settings",
  layout = "settings",
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly readOnly: boolean;
  readonly usageEntryPoint?: "settings" | "thread";
  readonly layout?: "settings" | "dialog";
  readonly onDone?: () => void;
}) {
  const dialog = layout === "dialog";
  const target = { environmentId, input: { instanceId } };
  const query = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const commands = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderAuth, commands);
  const respond = useAtomCommand(serverEnvironment.respondProviderAuth, commands);
  const complete = useAtomCommand(serverEnvironment.completeProviderAuth, commands);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, commands);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, commands);
  const [methodId, setMethodId] = useState("");
  const [draft, setDraft] = useState({ id: "", values: {} as Record<string, string> });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const terminalQueue = useRef<ProviderAuthRespondInput[]>([]);
  const terminalSending = useRef(false);
  const auth = query.data;
  const interaction = auth?.interaction;
  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const signedIn =
    provider.auth.status === "authenticated" ||
    (provider.auth.status === "unknown" && auth?.phase === "succeeded");
  const isDiscovering =
    provider.driver === "acpRegistry" &&
    !active &&
    !signedIn &&
    !query.error &&
    auth?.methods === undefined;
  const needsExternalSetup =
    !active &&
    !signedIn &&
    (provider.setup?.canAuthenticate === false ||
      (provider.driver === "acpRegistry" && auth?.methods?.length === 0));
  const usesCredentials =
    provider.driver === "antigravity" &&
    (provider.auth.type === "gemini-api-key" || provider.auth.type === "agent-platform");
  // A CLI login's status check can pass while its login is rejected, so signed-in rows offer it too.
  const usesCliLogin = auth?.methods?.length === 1 && auth.methods[0]?.id === "cli";
  const url =
    interaction?.type === "browser" || interaction?.type === "deviceCode"
      ? interaction.url
      : auth?.authorizationUrl;
  const opensBrowser =
    usesCliLogin && (interaction?.type === "credentials" || interaction?.type === "browser");
  const accountDescription = active
    ? !auth?.flowId
      ? (auth?.message ?? "Sign-in is in progress in another client.")
      : auth?.phase === "starting"
        ? (auth.message ?? (usesCredentials ? "Connecting…" : "Starting sign-in…"))
        : auth?.phase === "verifying"
          ? usesCredentials
            ? "Checking credentials and loading models…"
            : "Checking your account…"
          : interaction?.type === "terminal"
            ? "Complete sign-in in the terminal below."
            : opensBrowser && url
              ? "If the browser didn't open, visit:"
              : interaction?.type === "credentials"
                ? "Enter your credentials below."
                : "Finish signing in in your browser."
    : signedIn
      ? "Signed in."
      : isDiscovering
        ? "Discovering sign-in methods…"
        : needsExternalSetup
          ? "No in-app sign-in advertised. Follow the provider's docs to finish setup."
          : usesCredentials
            ? `Connect on ${environmentLabel} to load models.`
            : `Sign in on ${environmentLabel}.`;
  const statusMessage = auth?.phase === "failed" ? auth.message : null;
  const disabled = readOnly || pending || query.error !== null || isDiscovering;
  const draftId = `${auth?.flowId ?? ""}:${interaction?.id ?? ""}`;
  const values = draft.id === draftId ? draft.values : {};
  const browserFlowId = opensBrowser && !readOnly ? (auth?.flowId ?? null) : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the user's browser, once per sign-in.
  useEffect(() => {
    if (!browserFlowId || !url || autoOpenedFlowId === browserFlowId) return;
    autoOpenedFlowId = browserFlowId;
    // On its own machine the login opens a browser itself, and only that one can finish on localhost.
    if (sharesMachineWithEnvironment(environmentId)) return;
    void ensureLocalApi()
      .shell.openExternal(url)
      .catch(() => undefined);
  }, [browserFlowId, environmentId, url]);

  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    let succeeded = false;
    try {
      const result = await command();
      if (result._tag === "Success") succeeded = true;
      else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error ? failure.message : "Provider sign-in failed. Try again.",
        );
      }
    } catch {
      setError("Provider sign-in failed. Try again.");
    }
    pendingRef.current = false;
    setPending(false);
    return succeeded;
  }

  async function send(response: ProviderAuthResponse) {
    if (!auth?.flowId || !interaction) return false;
    return run(() =>
      respond({
        environmentId,
        input: { instanceId, flowId: auth.flowId!, interactionId: interaction.id, response },
      }),
    );
  }

  async function openBrowser() {
    if (!url || readOnly) return;
    const requiresConsent = interaction?.type === "browser" && interaction.requiresConsent;
    // Reserve tabs before awaiting consent; browsers block later opens.
    const pending = requiresConsent && !window.desktopBridge ? window.open("", "_blank") : null;
    if (pending) pending.opener = null;
    try {
      if (requiresConsent && !(await send({ type: "browser", action: "accept" }))) {
        pending?.close();
        return;
      }
      if (pending) pending.location.href = url;
      else await ensureLocalApi().shell.openExternal(url);
      setError(null);
    } catch {
      pending?.close();
      setError("Could not open the sign-in page. Copy the link and open it in your browser.");
    }
  }

  const formId = `provider-sign-in-${instanceId}`;
  const hasValues = Object.values(values).some((value) => value.trim().length > 0);
  const showCallback = Boolean(
    url && (interaction?.type === "browser" ? interaction.acceptsCallback : !interaction),
  );

  function updateDraft(name: string, value: string) {
    setDraft({ id: draftId, values: { ...values, [name]: value } });
  }

  const description =
    signedIn && !active && provider.auth.email?.trim() ? (
      <span>
        Signed in as{" "}
        <RedactedSensitiveText
          key={provider.auth.email}
          value={provider.auth.email}
          ariaLabel="Toggle account email visibility"
          revealTooltip="Click to reveal email"
          hideTooltip="Click to hide email"
          className="max-w-full truncate"
        />
      </span>
    ) : (
      <span role="status">{accountDescription}</span>
    );
  const selectControl = (
    <>
      {!active && (auth?.methods?.length ?? 0) > 1 ? (
        <Select
          value={auth?.methods?.some((method) => method.id === methodId) ? methodId : ""}
          disabled={disabled}
          onValueChange={(value) => setMethodId(value ?? "")}
        >
          <SelectTrigger size="sm" aria-label="Sign-in method" className="w-44">
            <SelectValue>
              {auth?.methods?.find((method) => method.id === methodId)?.name ?? "Provider default"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">Provider default</SelectItem>
            {auth?.methods?.map((method) => (
              <SelectItem key={method.id} value={method.id}>
                {method.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
    </>
  );
  const copyLinkControl = url ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Copy sign-in link"
            size="icon-sm"
            variant="ghost-muted"
            disabled={disabled}
            onClick={() => {
              // Copy during the click to retain clipboard activation; consent must still be
              // recorded before use.
              const copied = writeTextToClipboard(url, "Provider sign-in link");
              void (async () => {
                await copied;
                if (interaction?.type === "browser" && interaction.requiresConsent)
                  await send({ type: "browser", action: "accept" });
              })().catch(() => setError("Could not copy the sign-in link."));
            }}
          >
            <CopyIcon />
          </Button>
        }
      />
      <TooltipPopup>Copy sign-in link</TooltipPopup>
    </Tooltip>
  ) : null;
  const linkControls =
    url && !usesCliLogin ? (
      <>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => void openBrowser()}>
          {dialog ? "Open sign-in page" : "Open browser"}
        </Button>
        {copyLinkControl}
      </>
    ) : null;
  const cliLoginLink =
    url && usesCliLogin ? (
      <div className="flex min-w-0 items-center gap-1">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 truncate text-sm text-foreground underline underline-offset-2"
          onClick={(event) => {
            event.preventDefault();
            void openBrowser();
          }}
        >
          {url}
        </a>
        {copyLinkControl}
      </div>
    ) : null;
  const flowControl = (
    <>
      {needsExternalSetup && provider.setup?.documentationUrl ? (
        <Button
          size="sm"
          variant="outline"
          render={<a href={provider.setup.documentationUrl} target="_blank" rel="noreferrer" />}
        >
          Open docs
        </Button>
      ) : active && auth?.flowId ? (
        <Button
          size="sm"
          variant="ghost-muted"
          disabled={disabled}
          onClick={() =>
            void run(() => cancel({ environmentId, input: { instanceId, flowId: auth.flowId! } }))
          }
        >
          Cancel sign-in
        </Button>
      ) : !active && !needsExternalSetup && provider.setup?.canAuthenticate !== false ? (
        <Button
          size="sm"
          variant={dialog ? "default" : "outline"}
          disabled={disabled || !provider.enabled || !provider.installed || !auth}
          onClick={() => {
            if (usesCliLogin) {
              reportForkClientUsage(environmentId, {
                feature: "provider-sign-in",
                action: "start",
                entryPoint: usageEntryPoint,
              });
            }
            void run(() =>
              start({
                environmentId,
                input: {
                  instanceId,
                  ...(methodId && auth?.methods?.some((method) => method.id === methodId)
                    ? { methodId }
                    : {}),
                },
              }),
            );
          }}
        >
          {signedIn
            ? "Change account"
            : auth?.phase === "failed" || auth?.phase === "cancelled"
              ? usesCredentials
                ? "Retry connection"
                : "Retry sign-in"
              : usesCredentials
                ? "Connect"
                : "Sign in"}
        </Button>
      ) : null}
    </>
  );
  const signOutControl = (
    <>
      {!active && signedIn && (provider.auth.canLogout ?? provider.setup?.canAuthenticate) ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || !auth}
          onClick={() => {
            void ensureLocalApi()
              .dialogs.confirm(
                `Sign out of ${provider.displayName ?? provider.driver} on ${environmentLabel}? This stops running threads that share this sign-in. Thread history is kept.`,
              )
              .then((confirmed) => {
                if (confirmed) void run(() => logout(target));
              });
          }}
        >
          Sign out
        </Button>
      ) : null}
    </>
  );
  const details = (
    <>
      {interaction?.type === "terminal" ||
      interaction?.type === "credentials" ||
      interaction?.type === "deviceCode" ||
      showCallback ||
      cliLoginLink ||
      error ||
      query.error ? (
        <>
          {dialog ? null : cliLoginLink}
          {interaction?.type === "deviceCode" ? (
            <p className="py-2 text-sm text-muted-foreground">
              Enter code{" "}
              <code className="select-all font-mono text-foreground">{interaction.userCode}</code>{" "}
              in your browser.{" "}
              <InlineButton
                onClick={() =>
                  void writeTextToClipboard(interaction.userCode, "Sign-in code").catch(() =>
                    setError("Could not copy the code."),
                  )
                }
              >
                Copy code
              </InlineButton>
            </p>
          ) : null}
          {interaction?.type === "terminal" ? (
            <div className="py-2">
              <Suspense
                fallback={
                  <p className="text-xs text-muted-foreground">Loading sign-in terminal…</p>
                }
              >
                <ProviderAuthTerminal
                  key={`${auth?.flowId}:${interaction.id}`}
                  output={interaction.output}
                  outputOffset={interaction.outputOffset}
                  onResponse={(response) => {
                    if (readOnly || !auth?.flowId) return;
                    for (
                      let offset = 0;
                      offset < Math.max(1, response.data.length);
                      offset += 4_096
                    ) {
                      terminalQueue.current.push({
                        instanceId,
                        flowId: auth.flowId,
                        interactionId: interaction.id,
                        response: {
                          ...response,
                          data: response.data.slice(offset, offset + 4_096),
                        },
                      });
                    }
                    if (terminalSending.current) return;
                    terminalSending.current = true;
                    void (async () => {
                      while (terminalQueue.current.length > 0) {
                        const input = terminalQueue.current.shift()!;
                        const result = await respond({ environmentId, input });
                        if (result._tag !== "Success") {
                          terminalQueue.current = [];
                          if (!isAtomCommandInterrupted(result))
                            setError("The provider sign-in terminal is no longer available.");
                          break;
                        }
                      }
                    })()
                      .catch(() => {
                        terminalQueue.current = [];
                        setError("Could not send input to the provider sign-in terminal.");
                      })
                      .finally(() => {
                        terminalSending.current = false;
                      });
                  }}
                />
              </Suspense>
            </div>
          ) : null}
          {interaction?.type === "credentials" ? (
            <form
              id={formId}
              className={cn("grid gap-2 text-sm leading-normal", !dialog && "py-2")}
              onSubmit={(event) => {
                event.preventDefault();
                if (!hasValues) return;
                void send({ type: "credentials", values }).then((sent) => {
                  if (sent) setDraft({ id: "", values: {} });
                });
              }}
            >
              {interaction.fields.map((field) =>
                field.secret && interaction.url ? (
                  <label key={field.name} className="grid gap-1.5">
                    {field.label}
                    <Input
                      {...(dialog ? {} : { size: "sm" as const })}
                      type="text"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      data-1p-ignore
                      data-lpignore="true"
                      data-bwignore="true"
                      data-form-type="other"
                      autoFocus={dialog}
                      value={maskCode(values[field.name] ?? "")}
                      disabled={disabled}
                      maxLength={16_384}
                      onChange={(event) =>
                        updateDraft(
                          field.name,
                          applyMaskedEdit(
                            values[field.name] ?? "",
                            event.target.value,
                            event.target.selectionStart,
                          ),
                        )
                      }
                    />
                  </label>
                ) : (
                  <label key={field.name} className="grid gap-1.5">
                    {field.label}
                    <Input
                      {...(dialog ? {} : { size: "sm" as const })}
                      type={field.secret ? "password" : "text"}
                      autoComplete="off"
                      value={values[field.name] ?? ""}
                      disabled={disabled}
                      maxLength={16_384}
                      onChange={(event) => updateDraft(field.name, event.target.value)}
                    />
                  </label>
                ),
              )}
              {dialog ? null : (
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  disabled={disabled || !hasValues}
                >
                  {interaction.url ? "Continue" : "Connect"}
                </Button>
              )}
            </form>
          ) : null}
          {showCallback ? (
            <form
              id={formId}
              className={cn("grid gap-2 text-sm leading-normal", !dialog && "py-2")}
              onSubmit={(event) => {
                event.preventDefault();
                if (!auth?.flowId || !values.callback?.trim()) return;
                void run(() =>
                  complete({
                    environmentId,
                    input: { instanceId, flowId: auth.flowId!, callbackUrl: values.callback! },
                  }),
                ).then((sent) => {
                  if (sent) setDraft({ id: "", values: {} });
                });
              }}
            >
              <label className="grid gap-1">
                If the final localhost page does not load, paste its full URL here.
                <Input
                  size="sm"
                  id={`provider-callback-${instanceId}`}
                  type="url"
                  autoFocus={dialog}
                  autoComplete="off"
                  value={values.callback ?? ""}
                  disabled={disabled}
                  maxLength={16_384}
                  onChange={(event) => updateDraft("callback", event.target.value)}
                />
              </label>
              {dialog ? null : (
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  disabled={disabled || !values.callback?.trim()}
                >
                  Continue
                </Button>
              )}
            </form>
          ) : null}
          {error || query.error ? (
            <p role="alert" className="py-2 text-xs text-destructive">
              {error ?? query.error}
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
  if (dialog) {
    const hasForm =
      interaction?.type === "credentials" || (interaction?.type === "browser" && showCallback);
    return (
      <>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="grid gap-1">
              <p className="text-sm text-muted-foreground">{description}</p>
              {cliLoginLink}
            </div>
            {statusMessage ? (
              <p role="status" className="text-sm [overflow-wrap:anywhere]">
                {statusMessage}
              </p>
            ) : null}
            {linkControls ? <div className="flex items-center gap-1.5">{linkControls}</div> : null}
            {details}
          </div>
        </DialogPanel>
        <DialogFooter className="sm:justify-between">
          <div className="flex gap-2">{flowControl}</div>
          {hasForm ? (
            <Button type="submit" form={formId} disabled={disabled || !hasValues}>
              Continue
            </Button>
          ) : auth?.phase === "succeeded" ? (
            <Button onClick={onDone}>Done</Button>
          ) : null}
        </DialogFooter>
      </>
    );
  }
  return (
    <SettingsRow
      title="Account"
      description={description}
      status={
        statusMessage ? (
          <p role="status" className="[overflow-wrap:anywhere]">
            {statusMessage}
          </p>
        ) : undefined
      }
      control={
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {selectControl}
          {linkControls}
          {flowControl}
          {signOutControl}
        </div>
      }
    >
      {details}
    </SettingsRow>
  );
}
