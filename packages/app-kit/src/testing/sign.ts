import type { EventName, SabhaEvent } from "../events.js";
import { sign } from "../verify.js";

/**
 * A webhook delivery signed as Sabha signs it, for a handler test with no Sabha running.
 * `at` sets the timestamp (milliseconds), to test a stale delivery.
 */
export async function signedDelivery(params: {
  secret: string;
  payload: SabhaEvent | (Record<string, unknown> & { event: EventName | string });
  url?: string;
  at?: number;
  deliveryId?: string;
  /** X-Sabha-Timeout, in seconds: 300 for a reply Sabha will post, 30 otherwise, what's left of 15 for a command. */
  timeout?: number;
}): Promise<Request> {
  const body = JSON.stringify(params.payload);
  const timestamp = Math.floor((params.at ?? Date.now()) / 1000);
  return new Request(params.url ?? "https://app.test/", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Sabha-Event": String(params.payload.event),
      "X-Sabha-Delivery": params.deliveryId ?? crypto.randomUUID(),
      "X-Sabha-Timestamp": String(timestamp),
      "X-Sabha-Signature": await sign(params.secret, timestamp, body),
      ...(params.timeout === undefined ? {} : { "X-Sabha-Timeout": String(params.timeout) }),
    },
  });
}
