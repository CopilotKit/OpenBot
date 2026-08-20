/**
 * A fresh identifier, on every origin this app can be served from.
 *
 * `crypto.randomUUID` exists only in a secure context. On a laptop that is invisible, because
 * `http://localhost` counts as one; on a deployment reached at `http://<address>` it does not, and
 * the function is simply not there. Calling it throws inside a submit handler, the throw is
 * swallowed by React's event boundary, and the surface does nothing at all: no message, no error,
 * no clue. Found by opening a real deployment over plain HTTP and watching a chat quietly refuse to
 * start. This module exists so that failure cannot come back.
 *
 * `crypto.getRandomValues` has no such restriction and is what the fallback uses, so the ids are as
 * random either way. They are not secrets, but they do have to be unique, and `Math.random` is the
 * thing to avoid here rather than something to fall back to further.
 *
 * TLS is still what a deployment should have, for the cookies and the logins if nothing else. The
 * point is that a deployment without it should misbehave in ways an operator can see.
 */
export function newId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Version 4 and the RFC variant, so the result is a UUID rather than sixteen random bytes wearing
  // the shape of one.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}
