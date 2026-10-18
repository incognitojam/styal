import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export class EmailSendFailed extends Schema.TaggedError<EmailSendFailed>()("EmailSendFailed", {
  // Never the recipient or the body: both would put the code in logs.
  detail: Schema.String,
}) {
  override get message(): string {
    return `Sign-in email could not be sent: ${this.detail}`;
  }
}

export class EmailSender extends Context.Service<
  EmailSender,
  {
    /** False when the deployment has no sender; sign-in by email is then off. */
    readonly enabled: boolean;
    readonly send: (email: OutgoingEmail) => Effect.Effect<void, EmailSendFailed>;
  }
>()("t3code-relay/auth/EmailSender") {}

export const layerDisabled = Layer.succeed(EmailSender, {
  enabled: false,
  send: () => Effect.fail(new EmailSendFailed({ detail: "not_configured" })),
});

/**
 * Writes the message to the worker log instead of sending it. For personal
 * and dev stages without a sending domain; configuration refuses it on prod.
 */
export const layerLog = Layer.succeed(EmailSender, {
  enabled: true,
  send: (email) =>
    Effect.logInfo("Sign-in email (log delivery)", { to: email.to, text: email.text }),
});

export const make = (send: EmailSender["Service"]["send"]) =>
  EmailSender.of({ enabled: true, send });

export function renderSignInEmail(code: string): Omit<OutgoingEmail, "to"> {
  const text = [
    `Your eight-digit styal sign-in code is ${code}.`,
    "",
    "It expires in 10 minutes. If you didn't try to sign in, you can ignore this email.",
  ].join("\n");
  const html = [
    "<!doctype html>",
    '<html><body style="font-family: -apple-system, system-ui, sans-serif; color: #111;">',
    "<p>Your eight-digit styal sign-in code is</p>",
    `<p style="font-size: 28px; font-weight: 600; letter-spacing: 4px;">${code}</p>`,
    "<p>It expires in 10 minutes. If you didn't try to sign in, you can ignore this email.</p>",
    "</body></html>",
  ].join("");
  return { subject: `Your eight-digit styal sign-in code: ${code}`, text, html };
}
