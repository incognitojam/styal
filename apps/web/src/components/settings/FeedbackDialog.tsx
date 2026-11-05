import { useAtom, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FEEDBACK_REPOSITORY,
  type EnvironmentId,
  type FeedbackSubmitResult,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { ensureLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
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
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

// Hosted beside the command palette, which closes as its command runs.
const feedbackDialogEnvironmentAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("feedback:dialog-environment"),
);

// Survives closing the dialog, so a report outlasts a trip to the terminal to fix a sign-in.
const feedbackDraftAtom = Atom.make({ title: "", body: "" }).pipe(
  Atom.keepAlive,
  Atom.withLabel("feedback:draft"),
);

export function openFeedbackDialog(environmentId: EnvironmentId): void {
  appAtomRegistry.set(feedbackDialogEnvironmentAtom, environmentId);
}

export function FeedbackDialogHost() {
  const environmentId = useAtomValue(feedbackDialogEnvironmentAtom);
  if (environmentId === null) return null;
  return (
    <FeedbackDialog
      key={environmentId}
      environmentId={environmentId}
      onClose={() => appAtomRegistry.set(feedbackDialogEnvironmentAtom, null)}
    />
  );
}

function FeedbackDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const submit = useAtomCommand(serverEnvironment.submitFeedback, {
    label: "submit feedback",
    reportFailure: false,
  });
  const [draft, setDraft] = useAtom(feedbackDraftAtom);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FeedbackSubmitResult | null>(null);

  const send = async () => {
    setPending(true);
    setError(null);
    const outcome = await submit({
      environmentId: props.environmentId,
      input: { title: draft.title.trim(), body: draft.body.trim() },
    });
    setPending(false);
    if (outcome._tag === "Success") {
      setResult(outcome.value);
      if (outcome.value.status === "filed") setDraft({ title: "", body: "" });
      return;
    }
    const failure = squashAtomCommandFailure(outcome);
    setError(failure instanceof Error ? failure.message : "Could not send the report.");
  };

  const openExternal = (url: string) => void ensureLocalApi().shell.openExternal(url);
  const filed = result?.status === "filed" ? result : null;
  const notFiled = result?.status === "not_filed" ? result : null;

  return (
    <Dialog open onOpenChange={(open) => (open || pending ? undefined : props.onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>
            {filed
              ? "Your issue is posted."
              : `Report a bug or suggest a change. This posts a public issue on ${FEEDBACK_REPOSITORY} under the GitHub account signed in on this server, with your styal version and operating system added. Leave out anything private.`}
          </DialogDescription>
        </DialogHeader>
        {filed ? null : (
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <Input
                autoFocus
                aria-label="Title"
                placeholder="Title"
                maxLength={200}
                value={draft.title}
                disabled={pending}
                onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
              />
              <Textarea
                aria-label="Description"
                placeholder="What happened, and what did you expect?"
                rows={6}
                maxLength={60_000}
                value={draft.body}
                disabled={pending}
                onChange={(event) => setDraft({ ...draft, body: event.currentTarget.value })}
              />
              {notFiled ? (
                <p role="alert" className="text-xs text-destructive">
                  Your issue wasn't posted, and your text is still here. {notFiled.reason} You can
                  post again, or post it yourself on GitHub.
                </p>
              ) : null}
              {error === null ? null : (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
            </div>
          </DialogPanel>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={props.onClose}>
            Close
          </Button>
          {filed ? (
            <Button onClick={() => openExternal(filed.issueUrl)}>View issue</Button>
          ) : (
            <>
              {notFiled ? (
                <Button variant="outline" onClick={() => openExternal(notFiled.manualUrl)}>
                  Open on GitHub
                </Button>
              ) : null}
              <Button
                disabled={
                  pending || draft.title.trim().length === 0 || draft.body.trim().length === 0
                }
                onClick={() => void send()}
              >
                {pending ? "Posting…" : "Post publicly"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
