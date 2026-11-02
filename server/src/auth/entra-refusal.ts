/**
 * Why Entra would not issue a token for a person, in the terms they can act on.
 *
 * Its own module so the plugin store can tell these apart without loading sign-in: `entra.ts` throws
 * them, and the store turns each into the sentence the person reads.
 *
 * `no-sign-in`: the person has no Microsoft sign-in stored and no token from their app to stand in.
 * `sign-in-expired`: Entra no longer honours their sign-in (`invalid_grant`, or a sign-in it wants
 * repeated). `no-consent`: an admin has not granted OpenBot access to the system (`AADSTS65001` from
 * the on-behalf-of exchange). `no-api-consent`: the same code one step earlier, from the refresh
 * grant for OpenBot's own API, so what is missing is consent to OpenBot's API and not to the system.
 * `no-api`: OpenBot's app registration exposes no API, so there is no token to OpenBot to exchange
 * (`AADSTS500011`). `not-admitted`: OpenBot itself no longer lets the person in (an admin removed
 * them, or the SSO or domain rules changed), so nothing is asked of Entra at all. `refused`:
 * anything else, which the operator's log line names.
 */
export type EntraRefusal =
  | "not-admitted"
  | "no-sign-in"
  | "sign-in-expired"
  | "no-consent"
  | "no-api-consent"
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
