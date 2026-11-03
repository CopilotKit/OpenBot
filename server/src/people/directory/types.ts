/**
 * The people of this deployment as Intelligence's organization directory holds them, in OpenBot's
 * own words.
 *
 * A person used to be one row in `users` plus their rows in `user_roles`; who was removed was
 * `revoked_access`; their linked outside accounts were `identity_links`; the identity providers an
 * administrator registered were `sso_providers`. They now live in Intelligence's directory
 * (`docs/contracts/organization-directory.md` in the Intelligence repo). `client.ts` is the one place
 * that translates these names to the directory's.
 */
import type { UserPreferences } from "@openbot/shared/user-preferences";
import type { OpenBotRole } from "../../auth/roles";

/** One identity a person signs in with, as the issuer names them. No secret is ever part of it. */
export type SignInIdentity = { issuer: string; subject: string };

export type Person = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified: boolean;
  role: OpenBotRole;
  groups: string[];
  preferences: Partial<UserPreferences>;
  onboardingStep: number;
  onboardingCompletedAt: Date | null;
  lastSignedInAt: Date | null;
  signInIdentities: SignInIdentity[];
  /** The Intelligence dashboard user this person is, when Intelligence can tell. Read-only. */
  principalId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  /** Intelligence's version of the record, for optimistic concurrency and for ordering what arrives. */
  version: number;
};

/** What a new person is made of. `createdAt` and `deletedAt` only when copying an existing one in. */
export type PersonDraft = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified: boolean;
  role: OpenBotRole;
  groups?: string[];
  preferences?: Partial<UserPreferences>;
  onboardingStep?: number;
  onboardingCompletedAt?: Date | null;
  lastSignedInAt?: Date | null;
  signInIdentities?: SignInIdentity[];
  createdAt?: Date;
  deletedAt?: Date | null;
};

/**
 * The fields a change may set. Absent leaves a field as it is; `preferences`, `groups` and
 * `signInIdentities` are replaced whole. `lastSignedInAt` only ever moves forward in Intelligence.
 */
export type PersonChanges = Partial<
  Pick<
    Person,
    | "email"
    | "name"
    | "image"
    | "emailVerified"
    | "role"
    | "groups"
    | "preferences"
    | "onboardingStep"
    | "onboardingCompletedAt"
    | "signInIdentities"
  > & { lastSignedInAt: Date }
>;

/** An address an administrator (or the company's directory) removed, so it cannot sign in again. */
export type Removal = {
  email: string;
  removedAt: Date;
  /** A person id, or `scim:<connection>` when the company's directory deactivated them. */
  removedBy: string;
  version: number;
};

export type LinkedIdentityRecord = {
  id: string;
  userId: string;
  provider: string;
  realm: string;
  subject: string;
  handle: string | null;
  verifiedBy: "challenge" | "oauth";
  /** A vault row of this deployment's: the account's token. The secret never leaves OpenBot. */
  credentialId: string | null;
  status: "active" | "needs_reconnect";
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

/** A linked-identity write, and the vault rows no link holds any more because of it. */
export type IdentityWrite = {
  identity: LinkedIdentityRecord;
  released: string[];
};

/** An enterprise identity provider, without its secret: that stays in this deployment's database. */
export type IdentityProviderRecord = {
  providerId: string;
  issuer: string;
  domain: string;
  protocol: "oidc" | "saml";
  registeredBy: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type DirectoryChange = {
  kind: "person" | "identity" | "removal" | "identity_provider";
  id: string;
  personId: string | null;
  version: number;
  change: "created" | "updated" | "deleted" | "restored" | "purged";
};
