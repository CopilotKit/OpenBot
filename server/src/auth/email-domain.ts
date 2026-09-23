/**
 * Which addresses this deployment admits, on top of whatever the provider decided.
 *
 * WHY THE PROVIDER IS NOT ENOUGH. Each of the three answers a different question from "is this one
 * of our people". `MICROSOFT_OAUTH_TENANT_ID` defaults to `common`, which is any Microsoft account
 * including personal ones. Okta has no equivalent setting. Google has one, and it is better than
 * this, because Google verifies Workspace domain ownership: a deployment signing people in with
 * Google should narrow it there as well rather than instead.
 *
 * WHAT THIS IS NOT. A filter, not a boundary, and the difference is the address it is given.
 * OpenBot never sets `requireEmailVerification` and never reads `users.emailVerified`, and Entra's
 * `email` claim comes from a directory attribute that the tenant's own administrator writes. So on
 * a multi-tenant deployment this refuses somebody who fills in the form honestly and does not stop
 * somebody who does not. That is why `config.ts` refuses the combination of a list and
 * `tenantId: common` outright: the list is load-bearing there and cannot bear it.
 *
 * UNSET MEANS UNCHANGED. An empty list admits everybody, which is what every deployment running
 * today already does.
 */
import { domainToASCII } from "node:url";

/**
 * One domain, in the single spelling both sides of the comparison are reduced to.
 *
 * ONE FUNCTION FOR BOTH SIDES, for the reason `target.ts` gives about its own canonicaliser: "Two
 * copies drift, and the copy that misses an alias is the one that lets a credential endpoint
 * through." The list an operator writes and the address a provider returns go through this, so a
 * rule cannot mean one thing when written and another when matched.
 *
 * `domainToASCII` is IDNA/UTS-46, which is what a browser and a resolver apply. It lower-cases,
 * folds an IDN to punycode so a list may be written either way, maps the codepoints that are
 * defined to be equivalent, and answers "" for a name that is not one. A leading `@` is accepted
 * because `@example.com` is how people quote a domain; a trailing dot goes because it is the same
 * name to DNS.
 */
export function normalizeDomain(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/^@+/, "").replace(/\.+$/, "");
  if (!trimmed) return undefined;
  /*
   * Lower-cased here rather than left to `domainToASCII`, which folds case for the non-ASCII it
   * maps and does NOT promise it for an all-ASCII label. Measured: bun 1.3.14, which the published
   * image ships, returns "EXAMPLE.COM" unchanged, while bun 1.4.2 returns "example.com". Relying on
   * it meant a deployment refused its own people the moment an address arrived with a capital in
   * the domain, on the runtime it actually ships. The answer must not depend on what is underneath.
   */
  const ascii = domainToASCII(trimmed.toLowerCase());
  return ascii.length > 0 ? ascii.toLowerCase() : undefined;
}

/**
 * The domain an address is at, or undefined when it is not an address.
 *
 * Split on the LAST `@`, because a quoted local part may legally contain one
 * (`"a@b"@example.com`). That rule is only true of a quoted one: `a@b@example.com` is not an
 * address at all, and reading it as being at `example.com` would admit
 * `attacker@evil.test@example.com` to a deployment that named `example.com`. So an unquoted local
 * part carrying a second `@` is refused rather than interpreted.
 */
function emailDomain(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  if (at <= 0) return undefined;

  const local = email.slice(0, at);
  if (local.includes("@") && !(local.startsWith('"') && local.endsWith('"'))) {
    return undefined;
  }

  return normalizeDomain(email.slice(at + 1));
}

/**
 * May this address sign in?
 *
 * An empty list is "no opinion" and admits. An address with no readable domain is refused once a
 * list exists, because admitting something the rule cannot be applied to is the case the rule is
 * for.
 *
 * EXACT, NO WILDCARDS, for the reason `AGENT_ENDPOINT_ALLOWED_HOSTS` gives: a pattern that widens
 * by accident is the usual way a host check fails. `example.com` therefore admits neither
 * `sub.example.com` nor `evil-example.com`, and a deployment with subdomains names them.
 *
 * One thing it cannot see: an Entra B2B guest's UPN is `alice_contoso.com#EXT#@yours.onmicrosoft.com`,
 * so a deployment that names its own `onmicrosoft.com` domain admits every guest the tenant has
 * ever invited. Name the domains your staff actually use.
 */
export function emailDomainAllowed(
  email: string | null | undefined,
  allowedDomains: readonly string[],
): boolean {
  if (allowedDomains.length === 0) return true;
  if (typeof email !== "string") return false;

  const domain = emailDomain(email);
  if (!domain) return false;

  return allowedDomains.some((allowed) => normalizeDomain(allowed) === domain);
}

/** What a refused person is told. Names the rule, not the list, which is nobody else's business. */
export const DOMAIN_REFUSAL_MESSAGE =
  "This deployment does not admit that email domain. Sign in with your work account, or ask an administrator to add your domain.";
