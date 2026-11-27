import { T, Var, msg, useGT, useMessages } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import { ManagedRelay } from "@t3tools/client-runtime/relay-session";
import type { RelayAccountSessionRecord } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { LaptopIcon, LogOutIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { toastManager } from "../ui/toast";
import { useStableCallback } from "../../hooks/useStableCallback";

import { deleteRelayAccount, signOutOfRelay } from "../../cloud/relaySession";
import { useRelayAccount } from "../../cloud/useRelayAccount";
import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { AccountPage as AccountSection, AccountRefreshButton, AccountRow } from "./AccountPage";
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { T3ConnectUserProfilePage } from "./T3ConnectUserProfilePage";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { signInFailureMessage } from "./RelayEmailSignInForm.logic";
import { relayAccountDialogOpenAtom } from "./relayAuthDialogState";

const CLIENT_LABELS: Record<RelayAccountSessionRecord["clientId"], string> = {
  "t3-web": msg("Web or desktop"),
  "t3-mobile": msg("Mobile"),
  "t3-cli": msg("Command line"),
};

function lastUsedLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function SignedInDevices() {
  const resolve = useMessages();
  const gt = useGT();
  const { session } = useRelayAccount();
  const [sessions, setSessions] = useState<ReadonlyArray<RelayAccountSessionRecord> | null>(null);
  // The first load starts on mount; later loads set pending from the action that starts them.
  const [pending, setPending] = useState(session !== null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useStableCallback(async () => {
    if (session === null) return;
    const requestGeneration = ++generation.current;
    const exit = await runtime.runPromiseExit(
      ManagedRelay.ManagedRelayClient.pipe(
        Effect.flatMap((client) => client.listSessions({ credential: session.credential })),
      ),
    );
    if (generation.current !== requestGeneration) return;
    setPending(false);
    if (exit._tag === "Failure") {
      setError(signInFailureMessage(exit));
      return;
    }
    setError(null);
    setSessions(exit.value);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads this session's device list from the relay on mount; a new session remounts the list by key
  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const revoke = async (sessionId: string) => {
    if (session === null) return;
    const requestGeneration = ++generation.current;
    setPending(true);
    const exit = await runtime.runPromiseExit(
      ManagedRelay.ManagedRelayClient.pipe(
        Effect.flatMap((client) =>
          client.revokeSession({ credential: session.credential, sessionId }),
        ),
      ),
    );
    if (generation.current !== requestGeneration) return;
    if (exit._tag === "Failure") {
      setPending(false);
      setError(signInFailureMessage(exit));
      return;
    }
    await load();
  };

  return (
    <AccountSection
      title={gt("Signed-in devices")}
      description={gt(
        "Each place you're signed in to styal Link. Signing one out ends its session.",
      )}
      action={
        <AccountRefreshButton
          isPending={pending}
          onClick={() => {
            setPending(true);
            void load();
          }}
        />
      }
    >
      {error ? (
        <p role="alert" className="pb-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <ul>
        {(sessions ?? []).map((entry) => (
          <AccountRow key={entry.sessionId} icon={<LaptopIcon className="size-4" />}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span className="truncate">
                    {entry.label ?? resolve(CLIENT_LABELS[entry.clientId])}
                  </span>
                  {entry.current ? (
                    <Badge variant="outline">
                      <T>This device</T>
                    </Badge>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  <T>
                    <Var>{resolve(CLIENT_LABELS[entry.clientId])}</Var> · last used{" "}
                    <Var>{lastUsedLabel(entry.lastUsedAt)}</Var>
                  </T>
                </p>
              </div>
              {entry.current ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void revoke(entry.sessionId)}
                >
                  <T>Sign out</T>
                </Button>
              )}
            </div>
          </AccountRow>
        ))}
      </ul>
    </AccountSection>
  );
}

function DeleteAccountButton({ email }: { readonly email: string | null }) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setPending(true);
    setError(null);
    const exit = await runtime.runPromiseExit(deleteRelayAccount);
    setPending(false);
    if (exit._tag === "Failure") {
      setError(signInFailureMessage(exit));
      return;
    }
    setOpen(false);
  };

  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <T>Delete account</T>
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Delete your styal Link account?</T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {email ? (
                <T>
                  <Var>{email}</Var> will be deleted.{" "}
                </T>
              ) : null}
              <T>
                Every environment is unlinked and loses its styal Link address, mobile devices stop
                getting notifications, and every device is signed out. This cannot be undone.
              </T>
            </AlertDialogDescription>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={pending} />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button variant="destructive" disabled={pending} onClick={() => void confirm()}>
              {pending ? gt("Deleting…") : gt("Delete account")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

export function RelayAccountDialog() {
  const gt = useGT();
  const open = useAtomValue(relayAccountDialogOpenAtom);
  const { email, isSignedIn, session } = useRelayAccount();
  const [signingOut, setSigningOut] = useState(false);
  const setOpen = (next: boolean) => appAtomRegistry.set(relayAccountDialogOpenAtom, next);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the relay session can end in another tab, so the shared dialog atom follows it closed
  useEffect(() => {
    if (open && !isSignedIn) appAtomRegistry.set(relayAccountDialogOpenAtom, false);
  }, [isSignedIn, open]);

  return (
    <Dialog open={open && isSignedIn} onOpenChange={setOpen}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <T>styal Link account</T>
          </DialogTitle>
          <DialogDescription>{email ?? gt("Signed in")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {open ? (
            <div className="flex flex-col gap-8">
              <SignedInDevices key={session?.credential.refreshToken} />
              <T3ConnectUserProfilePage />
              <MobileClientsUserProfilePage />
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <DeleteAccountButton email={email} />
          <Button
            variant="outline"
            disabled={signingOut}
            onClick={() => {
              setSigningOut(true);
              void runtime.runPromiseExit(signOutOfRelay).then((exit) => {
                setSigningOut(false);
                if (exit._tag === "Failure")
                  toastManager.add({ type: "error", title: signInFailureMessage(exit) });
              });
            }}
          >
            <LogOutIcon />
            <T>Sign out</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
