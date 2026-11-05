import { useAtomValue } from "@effect/atom-react";
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
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FeedbackSubmitResult | null>(null);

  const send = async () => {
    setPending(true);
    setError(null);
    const outcome = await submit({
      environmentId: props.environmentId,
      input: { title: title.trim(), body: body.trim() },
    });
    setPending(false);
    if (outcome._tag === "Success") {
      setResult(outcome.value);
      return;
    }
    const failure = squashAtomCommandFailure(outcome);
    setError(failure instanceof Error ? failure.message : "Could not send the report.");
  };

  const openExternal = (url: string) => void ensureLocalApi().shell.openExternal(url);

  return (
    <Dialog open onOpenChange={(open) => (open || pending ? undefined : props.onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>
            {result === null
              ? `Report a bug or suggest a change. This posts a public issue on ${FEEDBACK_REPOSITORY} under the GitHub account signed in on this server, with your styal version and operating system added. Leave out anything private.`
              : result.status === "filed"
                ? "Your issue is posted."
                : `Your issue wasn't posted: ${result.reason} You can post it yourself on GitHub.`}
          </DialogDescription>
        </DialogHeader>
        {result === null ? (
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <Input
                autoFocus
                aria-label="Title"
                placeholder="Title"
                maxLength={200}
                value={title}
                disabled={pending}
                onChange={(event) => setTitle(event.currentTarget.value)}
              />
              <Textarea
                aria-label="Description"
                placeholder="What happened, and what did you expect?"
                rows={6}
                maxLength={60_000}
                value={body}
                disabled={pending}
                onChange={(event) => setBody(event.currentTarget.value)}
              />
              {error === null ? null : (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
            </div>
          </DialogPanel>
        ) : null}
        <DialogFooter>
          {result === null ? (
            <>
              <Button variant="ghost" disabled={pending} onClick={props.onClose}>
                Cancel
              </Button>
              <Button
                disabled={pending || title.trim().length === 0 || body.trim().length === 0}
                onClick={() => void send()}
              >
                {pending ? "Posting…" : "Post publicly"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={props.onClose}>
                Close
              </Button>
              <Button
                onClick={() =>
                  openExternal(result.status === "filed" ? result.issueUrl : result.manualUrl)
                }
              >
                {result.status === "filed" ? "View issue" : "Open on GitHub"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
