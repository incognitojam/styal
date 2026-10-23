import { useAtomValue } from "@effect/atom-react";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import type { RelayAccountSessionRecord } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import { LaptopIcon, LogOutIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { deleteRelayAccount, signOutOfRelay } from "../../cloud/relaySession";
import { useRelayAccount } from "../../cloud/useRelayAccount";
import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  ClerkUserProfilePage as AccountSection,
  ClerkUserProfileRefreshButton as AccountRefreshButton,
  ClerkUserProfileRow as AccountRow,
} from "../clerk/ClerkUserProfilePage";
import { MobileClientsUserProfilePage } from "../clerk/MobileClientsUserProfilePage";
import { T3ConnectUserProfilePage } from "../clerk/T3ConnectUserProfilePage";
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
import { relayAccountDialogOpenAtom } from "./relayAuthDialogs";

const CLIENT_LABELS: Record<RelayAccountSessionRecord["clientId"], string> = {
  "t3-web": "Web or desktop",
  "t3-mobile": "Mobile",
  "t3-cli": "Command line",
};

function lastUsedLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function SignedInDevices() {
  const { session } = useRelayAccount();
  const [sessions, setSessions] = useState<ReadonlyArray<RelayAccountSessionRecord> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (session === null) return;
    const requestGeneration = ++generation.current;
    setPending(true);
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
  }, [session]);

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
    setPending(false);
    if (exit._tag === "Failure") {
      setError(signInFailureMessage(exit));
      return;
    }
    await load();
  };

  return (
    <AccountSection
      title="Signed-in devices"
      description="Each place you're signed in to styal Link. Signing one out ends its session."
      action={<AccountRefreshButton isPending={pending} onClick={() => void load()} />}
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
                  <span className="truncate">{entry.label ?? CLIENT_LABELS[entry.clientId]}</span>
                  {entry.current ? <Badge variant="outline">This device</Badge> : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {CLIENT_LABELS[entry.clientId]} · last used {lastUsedLabel(entry.lastUsedAt)}
                </p>
              </div>
              {entry.current ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void revoke(entry.sessionId)}
                >
                  Sign out
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
        Delete account
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your styal Link account?</AlertDialogTitle>
            <AlertDialogDescription>
              {email ? `${email} will be deleted. ` : null}Every environment is unlinked and loses
              its styal Link address, mobile devices stop getting notifications, and every device is
              signed out. This cannot be undone.
            </AlertDialogDescription>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={pending} />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={pending} onClick={() => void confirm()}>
              {pending ? "Deleting…" : "Delete account"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

export function RelayAccountDialog() {
  const open = useAtomValue(relayAccountDialogOpenAtom);
  const { email, isSignedIn, session } = useRelayAccount();
  const [signingOut, setSigningOut] = useState(false);
  const setOpen = (next: boolean) => appAtomRegistry.set(relayAccountDialogOpenAtom, next);

  // Signing out from inside the dialog, or in another tab, closes it.
  useEffect(() => {
    if (open && !isSignedIn) appAtomRegistry.set(relayAccountDialogOpenAtom, false);
  }, [isSignedIn, open]);

  return (
    <Dialog open={open && isSignedIn} onOpenChange={setOpen}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>styal Link account</DialogTitle>
          <DialogDescription>{email ?? "Signed in"}</DialogDescription>
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
              void runtime.runPromiseExit(signOutOfRelay).then(() => setSigningOut(false));
            }}
          >
            <LogOutIcon />
            Sign out
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
