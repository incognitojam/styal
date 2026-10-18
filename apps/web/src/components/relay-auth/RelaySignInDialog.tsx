import { useAtomValue } from "@effect/atom-react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { relaySignInDialogOpenAtom } from "./relayAuthDialogs";
import { RelayEmailSignInForm } from "./RelayEmailSignInForm";

export function RelaySignInDialog() {
  const open = useAtomValue(relaySignInDialogOpenAtom);
  const setOpen = (next: boolean) => appAtomRegistry.set(relaySignInDialogOpenAtom, next);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Sign in to styal Link</DialogTitle>
          <DialogDescription>
            We'll email you an eight-digit code. New accounts are created on first sign-in.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {open ? <RelayEmailSignInForm onSignedIn={() => setOpen(false)} /> : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
