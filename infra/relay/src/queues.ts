import * as Cloudflare from "alchemy/Cloudflare";

export const RelayApnsDeliveryDeadLetterQueue = Cloudflare.Queues.Queue(
  "RelayApnsDeliveryDeadLetterQueue",
);

export const RelayApnsDeliveryQueue = Cloudflare.Queues.Queue("RelayApnsDeliveryQueue");

export const RelayFcmDeliveryQueue = Cloudflare.Queues.Queue("RelayFcmDeliveryQueue");
export const RelayFcmDeliveryDeadLetterQueue = Cloudflare.Queues.Queue(
  "RelayFcmDeliveryDeadLetterQueue",
);

/**
 * Cloudflare queue bindings accept `delaySeconds`, and alchemy forwards the options object
 * to the binding unchanged, but its `SendOptions` type only declares `contentType`.
 */
export function queueSendOptions(options: { readonly delaySeconds?: number } | undefined) {
  return options as Cloudflare.Queues.SendOptions | undefined;
}
