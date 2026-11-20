import { createHmac } from "node:crypto";

/**
 * The token one computer checks its callers against, derived from the deployment's `COMPUTER_TOKEN`.
 *
 * WHY EACH COMPUTER HAS ITS OWN. A person's computer, and an isolated Bot's, is the boundary between
 * one tenant and the next: a Bot may run anything it likes on its own person's computer, root
 * included, and nothing on anybody else's. A computer was handed the deployment's token itself, and
 * a Bot can read it off its own computer's process (`/proc/1/environ`), so one Bot's shell held the
 * key to every computer it could reach on the network, and with it every other person's files and
 * signed-in browsers. Nothing of that went through the server, so nothing was audited either.
 *
 * Now the supervisor and the sandbox provider give each computer `HMAC-SHA256(COMPUTER_TOKEN, label)`
 * for whose computer it is, and the server derives the same value whenever it calls that computer.
 * A Bot that reads its own computer's token can open that computer, which it is already on, and no
 * other: the token another computer takes is a different HMAC, and the deployment's token, from which
 * every one of them is made, never reaches a computer at all.
 *
 * WHOSE COMPUTER is `person:<id>` or `bot:<id>`, the same text the server keys every computer by
 * (computer-key.ts `computerKeyText`) and the supervisor names its containers from. An isolated Bot's
 * computer, and a person's own browser's (`bot:person-<hex>`), are both `bot:`. The kind is fixed and
 * the id is the rest of the string, so no two computers derive one label.
 *
 * The label carries a version so a change to the scheme mints new tokens, which the supervisor and the
 * sandbox provider then treat as stale, rather than reinterpreting old ones.
 *
 * WHICH ORGANIZATION. A person in two organizations has a computer in each, and the two must not open
 * each other. So outside the `default` organization the label also names the organization, as
 * `org/<encodeURIComponent(org)>/person:<id>`, the same text the server keys such a computer by. In
 * `default`, and when no organization is given, the label is exactly what it was before organizations
 * were named here, so a computer already running in `default` keeps its token and is not treated as
 * stale. An organization id is encoded, so no `/` or `:` in it can make one label read as another.
 *
 * The one computer everybody shares (no supervisor, `AGENT_COMPUTER_URL`) is not a tenant boundary
 * and is documented as not being one; it keeps the deployment's token. So does OpenBot Desktop's
 * host-side browser computer, which runs a person's own browsers and no Bot.
 *
 * In `shared/` so the server and the supervisor run one implementation: the supervisor's image copies
 * this file in beside its own source (supervisor/Dockerfile), as the computer's copies the shared
 * files it imports.
 */
export const COMPUTER_TOKEN_LABEL = "openbot computer token v1";

/** The organization whose computers keep the labels they had before organizations were named. */
export const DEFAULT_COMPUTER_ORGANIZATION = "default";

export type ComputerIdentity = {
  kind: "person" | "bot";
  id: string;
  /** The organization the computer belongs to. Absent or `default` keeps the original label. */
  organizationId?: string;
};

/** Whose computer, as the text the token is derived from. */
export function computerTokenSubject(computer: ComputerIdentity): string {
  const own = `${computer.kind}:${computer.id}`;
  const organization = computer.organizationId;
  if (!organization || organization === DEFAULT_COMPUTER_ORGANIZATION)
    return own;
  return `org/${encodeURIComponent(organization)}/${own}`;
}

export function computerTokenFor(
  deploymentToken: string,
  computer: ComputerIdentity,
): string {
  return createHmac("sha256", deploymentToken)
    .update(`${COMPUTER_TOKEN_LABEL}\n${computerTokenSubject(computer)}`)
    .digest("hex");
}
