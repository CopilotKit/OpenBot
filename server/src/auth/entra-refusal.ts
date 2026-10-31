/**
 * Why Entra would not issue a token for a person, in the terms they can act on.
 *
 * Its own module so the plugin store can tell these apart without loading sign-in: `entra.ts` throws
 * them, and the store turns each into the sentence the person reads.
 *
 * `no-sign-in`: the person has no Microsoft sign-in stored and no token from their app to stand in.
 * `sign-in-expired`: Entra no longer honours their sign-in (`invalid_grant`, or a sign-in it wants
 * repeated). `no-consent`: an admin has not granted OpenBot access to the system (`AADSTS65001`).
 * `no-api`: OpenBot's app registration exposes no API, so there is no token to OpenBot to exchange
 * (`AADSTS500011`). `refused`: anything else, which the operator's log line names.
 */
export type EntraRefusal =
  | "no-sign-in"
  | "sign-in-expired"
  | "no-consent"
  | "no-api"
  | "refused";

export class EntraTokenRefusedError extends Error {
  constructor(
    readonly reason: EntraRefusal,
    message: string,
  ) {
    super(message);
    this.name = "EntraTokenRefusedError";
  }
}

/** What the plugin store asks of `entra.ts`: a token for one person and one system's scope. */
export type EntraTokens = {
  tokenFor(userId: string, scope: string): Promise<string>;
};
