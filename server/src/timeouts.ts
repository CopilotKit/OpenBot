/**
 * How long the server waits on another service, for the calls that share a reason.
 *
 * Only values that several call sites share for the same reason live here. A timeout that belongs
 * to one call stays next to it (the plugin store's token timeout, Google Drive's listing timeout),
 * because its reason is about that call.
 */

/**
 * One request to an OAuth or identity provider: a token exchange or refresh, a client registration,
 * the account lookup after sign-in. A single round trip that either answers or is not going to.
 */
export const OAUTH_REQUEST_TIMEOUT_MS = 15_000;

/**
 * One hand-off to a delivery transport: a push notification, an SMS, a message to OpenTag. Longer
 * than an OAuth request because these carry a person's message and a slow answer is still worth
 * waiting for, and short enough that a stuck transport does not hold the delivery queue.
 */
export const DELIVERY_REQUEST_TIMEOUT_MS = 30_000;
