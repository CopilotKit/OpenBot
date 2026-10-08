export type IdentityProvider = "slack" | "github";
export type LinkMethod = "challenge" | "oauth";
export type LinkStatus = "active" | "needs_reconnect";

/** Who somebody is at a provider. `subject` is the provider's stable id, never a display name. */
export type Identity = {
  provider: IdentityProvider;
  realm: string;
  subject: string;
};

export type IdentityLink = Identity & {
  id: string;
  userId: string;
  handle: string | null;
  verifiedBy: LinkMethod;
  credentialId: string | null;
  status: LinkStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** No caller-controlled identifiers, tokens, or database parameters appear in these errors. */
export class IdentityLinkError extends Error {
  constructor(message = "Link challenge is invalid, expired, or unconfirmed.") {
    super(message);
    this.name = "IdentityLinkError";
  }
}

export class IdentityConflictError extends Error {
  constructor() {
    super("This account is already linked to another OpenBot user.");
    this.name = "IdentityConflictError";
  }
}

export class IdentityInputError extends Error {
  constructor(message = "Identity is not valid.") {
    super(message);
    this.name = "IdentityInputError";
  }
}
