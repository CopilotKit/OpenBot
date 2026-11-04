/**
 * Intelligence's organization directory, as OpenBot calls it: people, removed addresses, linked
 * outside accounts and enterprise identity providers, under this deployment's project key. The
 * contract is Intelligence's `docs/contracts/organization-directory.md`.
 *
 * Every write carries an `Idempotency-Key`, and a write that fails on the way (the connection drops,
 * Intelligence answers 5xx) is retried with the same key, so a retry after a lost response is the
 * same write rather than a second one. Nothing here holds a database connection: a caller must never
 * call this with an OpenBot transaction open.
 */
import type { OpenBotRole } from "../../auth/roles";
import type {
  DirectoryChange,
  IdentityProviderRecord,
  IdentityWrite,
  LinkedIdentityRecord,
  Person,
  PersonChanges,
  PersonDraft,
  Removal,
  ScimGroupImport,
  ScimUserImport,
  SignInIdentity,
} from "./types";

export type DirectorySettings = {
  apiUrl: string;
  apiKey: string;
  /** For tests that need to observe or stub the transport. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

/** Intelligence refused or could not answer. `code` is the directory's error code when it sent one. */
export class DirectoryError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "DirectoryError";
  }
}

/** The record changed since it was read: somebody else saved first. Read it again and redo the change. */
export class DirectoryVersionConflictError extends DirectoryError {
  constructor(what: string) {
    super(
      `${what} changed since it was read.`,
      412,
      "DIRECTORY_VERSION_CONFLICT",
    );
    this.name = "DirectoryVersionConflictError";
  }
}

/** No such person in Intelligence: never created, or deleted for good. */
export class PersonMissingError extends DirectoryError {
  constructor(id: string) {
    super(
      `Person ${id} is not in Intelligence.`,
      404,
      "DIRECTORY_PERSON_NOT_FOUND",
    );
    this.name = "PersonMissingError";
  }
}

export class PersonAlreadyExistsError extends DirectoryError {
  constructor(id: string) {
    super(
      `Person ${id} already exists.`,
      409,
      "DIRECTORY_PERSON_ALREADY_EXISTS",
    );
    this.name = "PersonAlreadyExistsError";
  }
}

/** Another person in Intelligence holds this address. */
export class EmailTakenError extends DirectoryError {
  constructor(id: string) {
    super(
      `Another person in Intelligence holds the address of ${id}.`,
      409,
      "DIRECTORY_EMAIL_TAKEN",
    );
    this.name = "EmailTakenError";
  }
}

/** The person is soft-deleted in Intelligence, so they cannot be changed until restored. */
export class PersonDeletedError extends DirectoryError {
  constructor(id: string) {
    super(`Person ${id} is deleted.`, 409, "DIRECTORY_PERSON_DELETED");
    this.name = "PersonDeletedError";
  }
}

/** The outside account is linked to somebody else. */
export class IdentityLinkedElsewhereError extends DirectoryError {
  constructor() {
    super(
      "This account is linked to another person.",
      409,
      "DIRECTORY_IDENTITY_LINKED_ELSEWHERE",
    );
    this.name = "IdentityLinkedElsewhereError";
  }
}

/** The vault row is already another link's. */
export class CredentialTakenError extends DirectoryError {
  constructor() {
    super(
      "This credential belongs to another link.",
      409,
      "DIRECTORY_CREDENTIAL_TAKEN",
    );
    this.name = "CredentialTakenError";
  }
}

type WirePerson = {
  id: string;
  createdAt: string;
  version: number;
  updatedAt: string;
  deletedAt: string | null;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified: boolean;
  role: "admin" | "member";
  groups: string[];
  preferences: Record<string, unknown>;
  onboardingStep: number;
  onboardingCompletedAt: string | null;
  lastSignedInAt: string | null;
  signInIdentities: SignInIdentity[];
  principalId: string | null;
  provisionedBy?: string | null;
};

type WireRemoval = {
  email: string;
  removedAt: string;
  removedBy: string;
  version: number;
};

type WireIdentity = {
  id: string;
  personId: string;
  provider: string;
  realm: string;
  subject: string;
  handle: string | null;
  verifiedBy: "challenge" | "oauth";
  credentialRef: string | null;
  status: "active" | "needs_reconnect";
  version: number;
  createdAt: string;
  updatedAt: string;
};

type WireIdentityProvider = {
  providerId: string;
  issuer: string;
  domain: string;
  protocol: "oidc" | "saml";
  registeredBy: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type PeoplePage = {
  people: Person[];
  nextCursor: string | null;
  joinCode: string | null;
};

export type DirectoryClient = ReturnType<typeof createDirectoryClient>;

const ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

/** A fresh key for one logical write. Retries of that write reuse it. */
export function idempotencyKey(operation: string): string {
  return `openbot:${operation}:${crypto.randomUUID()}`;
}

/** OpenBot calls a plain member a user; the directory, like Clerk, calls them a member. */
export function roleToWire(role: OpenBotRole): "admin" | "member" {
  return role === "admin" ? "admin" : "member";
}

export function roleFromWire(role: string): OpenBotRole {
  return role === "admin" ? "admin" : "user";
}

const date = (value: string | null) => (value ? new Date(value) : null);

function personFromWire(wire: WirePerson): Person {
  return {
    id: wire.id,
    email: wire.email,
    name: wire.name,
    image: wire.image,
    emailVerified: wire.emailVerified,
    role: roleFromWire(wire.role),
    groups: wire.groups ?? [],
    preferences: wire.preferences ?? {},
    onboardingStep: wire.onboardingStep ?? 0,
    onboardingCompletedAt: date(wire.onboardingCompletedAt),
    lastSignedInAt: date(wire.lastSignedInAt),
    signInIdentities: wire.signInIdentities ?? [],
    principalId: wire.principalId ?? null,
    provisionedBy: wire.provisionedBy ?? null,
    createdAt: new Date(wire.createdAt),
    updatedAt: new Date(wire.updatedAt),
    deletedAt: date(wire.deletedAt),
    version: wire.version,
  };
}

function draftToWire(draft: PersonDraft) {
  return {
    id: draft.id,
    email: draft.email,
    name: draft.name,
    image: draft.image,
    emailVerified: draft.emailVerified,
    role: roleToWire(draft.role),
    ...(draft.groups ? { groups: draft.groups } : {}),
    ...(draft.preferences ? { preferences: draft.preferences } : {}),
    ...(draft.onboardingStep !== undefined
      ? { onboardingStep: draft.onboardingStep }
      : {}),
    ...(draft.onboardingCompletedAt
      ? { onboardingCompletedAt: draft.onboardingCompletedAt.toISOString() }
      : {}),
    ...(draft.lastSignedInAt
      ? { lastSignedInAt: draft.lastSignedInAt.toISOString() }
      : {}),
    ...(draft.signInIdentities
      ? { signInIdentities: draft.signInIdentities }
      : {}),
    ...(draft.createdAt ? { createdAt: draft.createdAt.toISOString() } : {}),
    ...(draft.deletedAt ? { deletedAt: draft.deletedAt.toISOString() } : {}),
  };
}

function changesToWire(changes: PersonChanges) {
  const wire: Record<string, unknown> = {};
  if (changes.email !== undefined) wire.email = changes.email;
  if (changes.name !== undefined) wire.name = changes.name;
  if (changes.image !== undefined) wire.image = changes.image;
  if (changes.emailVerified !== undefined)
    wire.emailVerified = changes.emailVerified;
  if (changes.role !== undefined) wire.role = roleToWire(changes.role);
  if (changes.groups !== undefined) wire.groups = changes.groups;
  if (changes.preferences !== undefined) wire.preferences = changes.preferences;
  if (changes.onboardingStep !== undefined)
    wire.onboardingStep = changes.onboardingStep;
  if (changes.onboardingCompletedAt !== undefined)
    wire.onboardingCompletedAt = changes.onboardingCompletedAt
      ? changes.onboardingCompletedAt.toISOString()
      : null;
  if (changes.lastSignedInAt !== undefined)
    wire.lastSignedInAt = changes.lastSignedInAt.toISOString();
  if (changes.signInIdentities !== undefined)
    wire.signInIdentities = changes.signInIdentities;
  return wire;
}

function removalFromWire(wire: WireRemoval): Removal {
  return {
    email: wire.email,
    removedAt: new Date(wire.removedAt),
    removedBy: wire.removedBy,
    version: wire.version,
  };
}

function identityFromWire(wire: WireIdentity): LinkedIdentityRecord {
  return {
    id: wire.id,
    userId: wire.personId,
    provider: wire.provider,
    realm: wire.realm,
    subject: wire.subject,
    handle: wire.handle,
    verifiedBy: wire.verifiedBy,
    credentialId: wire.credentialRef,
    status: wire.status,
    version: wire.version,
    createdAt: new Date(wire.createdAt),
    updatedAt: new Date(wire.updatedAt),
  };
}

function identityProviderFromWire(
  wire: WireIdentityProvider,
): IdentityProviderRecord {
  return {
    providerId: wire.providerId,
    issuer: wire.issuer,
    domain: wire.domain,
    protocol: wire.protocol,
    registeredBy: wire.registeredBy,
    version: wire.version,
    createdAt: new Date(wire.createdAt),
    updatedAt: new Date(wire.updatedAt),
  };
}

/** The address as the directory keys it, so a provider's choice of case cannot make a second one. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createDirectoryClient(settings: DirectorySettings) {
  const base = settings.apiUrl.replace(/\/+$/, "");
  const send = settings.fetch ?? fetch;

  async function request(
    method: string,
    path: string,
    options: {
      body?: unknown;
      idempotencyKey?: string;
      ifMatch?: number;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${settings.apiKey}`,
      accept: "application/json",
    };
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
    if (options.idempotencyKey)
      headers["idempotency-key"] = options.idempotencyKey;
    if (options.ifMatch !== undefined)
      headers["if-match"] = `"${options.ifMatch}"`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const response = await send(`${base}${path}`, {
          method,
          headers,
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        // A 5xx is Intelligence failing, not refusing: the same write under the same key is safe to
        // send again, and a read is safe to repeat.
        if (response.status >= 500 && attempt < ATTEMPTS) {
          lastError = new DirectoryError(
            `Intelligence answered ${response.status} to ${method} ${path}.`,
            response.status,
            await errorCode(response),
          );
          await pause(attempt);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < ATTEMPTS) await pause(attempt);
      }
    }
    if (lastError instanceof DirectoryError) throw lastError;
    throw new DirectoryError(
      `Could not reach Intelligence for ${method} ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      null,
      null,
    );
  }

  async function refusal(
    response: Response,
    what: string,
    action: string,
  ): Promise<never> {
    const code = await errorCode(response);
    switch (code) {
      case "DIRECTORY_PERSON_NOT_FOUND":
        throw new PersonMissingError(what);
      case "DIRECTORY_VERSION_CONFLICT":
        throw new DirectoryVersionConflictError(what);
      case "DIRECTORY_PERSON_ALREADY_EXISTS":
        throw new PersonAlreadyExistsError(what);
      case "DIRECTORY_EMAIL_TAKEN":
        throw new EmailTakenError(what);
      case "DIRECTORY_PERSON_DELETED":
        throw new PersonDeletedError(what);
      case "DIRECTORY_IDENTITY_LINKED_ELSEWHERE":
        throw new IdentityLinkedElsewhereError();
      case "DIRECTORY_CREDENTIAL_TAKEN":
        throw new CredentialTakenError();
    }
    if (response.status === 412) throw new DirectoryVersionConflictError(what);
    throw new DirectoryError(
      `Intelligence refused to ${action} ${what}: ${response.status}${code ? ` ${code}` : ""}.`,
      response.status,
      code,
    );
  }

  const personPath = (id: string) =>
    `/api/directory/people/${encodeURIComponent(id)}`;
  const removalPath = (email: string) =>
    `/api/directory/removals/${encodeURIComponent(normalizeEmail(email))}`;
  const identityPath = (id: string) =>
    `/api/directory/identities/${encodeURIComponent(id)}`;
  const identityProviderPath = (providerId: string) =>
    `/api/directory/identity-providers/${encodeURIComponent(providerId)}`;

  const client = {
    async createPerson(draft: PersonDraft, key: string): Promise<Person> {
      const response = await request("POST", "/api/directory/people", {
        body: draftToWire(draft),
        idempotencyKey: key,
      });
      if (response.status !== 201 && response.status !== 200)
        return refusal(response, `person ${draft.id}`, "create");
      return personFromWire((await response.json()) as WirePerson);
    },

    /** The person, soft-deleted ones included, or null when Intelligence has no such person. */
    async getPerson(id: string): Promise<Person | null> {
      const response = await request(
        "GET",
        `${personPath(id)}?includeDeleted=true`,
      );
      if (response.status === 404) return null;
      if (response.status !== 200)
        return refusal(response, `person ${id}`, "read");
      return personFromWire((await response.json()) as WirePerson);
    },

    async pagePeople(
      filter: { includeDeleted?: boolean; email?: string } = {},
      cursor: string | null = null,
      limit = 200,
    ): Promise<PeoplePage> {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor) query.set("cursor", cursor);
      if (filter.includeDeleted) query.set("includeDeleted", "true");
      if (filter.email) query.set("email", normalizeEmail(filter.email));
      const response = await request("GET", `/api/directory/people?${query}`);
      if (response.status !== 200) return refusal(response, "people", "list");
      const body = (await response.json()) as {
        people: WirePerson[];
        nextCursor: string | null;
        joinCode?: string | null;
      };
      return {
        people: body.people.map(personFromWire),
        nextCursor: body.nextCursor,
        joinCode: body.joinCode ?? null,
      };
    },

    /** Every person, walking every page. There is no cap: the cursor decides the end. */
    async allPeople(
      filter: { includeDeleted?: boolean } = {},
    ): Promise<{ people: Person[]; joinCode: string | null }> {
      const people: Person[] = [];
      let cursor: string | null = null;
      let joinCode: string | null = null;
      do {
        const page: PeoplePage = await client.pagePeople(filter, cursor);
        people.push(...page.people);
        joinCode = page.joinCode ?? joinCode;
        cursor = page.nextCursor;
      } while (cursor);
      return { people, joinCode };
    },

    async updatePerson(
      id: string,
      version: number,
      changes: PersonChanges,
      key: string,
    ): Promise<Person> {
      const response = await request("PATCH", personPath(id), {
        body: changesToWire(changes),
        ifMatch: version,
        idempotencyKey: key,
      });
      if (response.status !== 200)
        return refusal(response, `person ${id}`, "change");
      return personFromWire((await response.json()) as WirePerson);
    },

    /** Soft delete: the person stays, readable, with `deletedAt` set. */
    async deletePerson(id: string, key: string): Promise<Person> {
      const response = await request("DELETE", personPath(id), {
        idempotencyKey: key,
      });
      if (response.status !== 200)
        return refusal(response, `person ${id}`, "delete");
      return personFromWire((await response.json()) as WirePerson);
    },

    /** Delete for good, with every link of theirs. True when this call removed them. */
    async purgePerson(id: string, key: string): Promise<boolean> {
      const response = await request("DELETE", `${personPath(id)}?purge=true`, {
        idempotencyKey: key,
      });
      if (response.status === 404) return false;
      if (response.status !== 204)
        return refusal(response, `person ${id}`, "purge");
      return true;
    },

    /** The organization and project this deployment's key belongs to. */
    async scope(): Promise<{ organizationId: string; projectId: string }> {
      const response = await request("GET", "/api/directory/scope");
      if (response.status !== 200)
        return refusal(response, "the directory", "read the scope of");
      return (await response.json()) as {
        organizationId: string;
        projectId: string;
      };
    },

    /** The names of the project's directory groups (what SCIM provisioned). */
    async groupNames(): Promise<string[]> {
      const response = await request("GET", "/api/directory/groups");
      if (response.status !== 200)
        return refusal(response, "directory groups", "list");
      return ((await response.json()) as { groups: string[] }).groups;
    },

    /** The bearer tokens a SCIM connection accepts, as SHA-256 hashes: never the tokens. */
    async putScimConnection(
      connectionId: string,
      tokenHashes: string[],
    ): Promise<void> {
      const response = await request(
        "PUT",
        `/api/directory/scim/connections/${encodeURIComponent(connectionId)}`,
        { body: { tokenHashes } },
      );
      if (response.status !== 200)
        return refusal(response, `SCIM connection ${connectionId}`, "set");
    },

    /** SCIM users and groups this deployment served itself, under their own ids. */
    async importScim(
      connectionId: string,
      users: ScimUserImport[],
      groups: ScimGroupImport[],
    ): Promise<{ users: number; groups: number }> {
      const response = await request("POST", "/api/directory/scim/import", {
        body: { connectionId, users, groups },
      });
      if (response.status !== 200)
        return refusal(
          response,
          `SCIM connection ${connectionId}`,
          "copy into",
        );
      return (await response.json()) as { users: number; groups: number };
    },

    /** Credentials for the realtime topic that announces every change to this project's directory. */
    async subscribe(): Promise<{ joinToken: string; joinCode: string }> {
      const response = await request("POST", "/api/directory/subscribe", {
        body: {},
      });
      if (response.status !== 200)
        return refusal(response, "the directory", "subscribe to");
      return (await response.json()) as { joinToken: string; joinCode: string };
    },

    /** Remove an address. `created` is false when it was already removed: the earlier removal stands. */
    async putRemoval(
      email: string,
      removedBy: string,
      key: string,
      removedAt?: Date,
    ): Promise<{ removal: Removal; created: boolean }> {
      const response = await request("PUT", removalPath(email), {
        body: {
          removedBy,
          ...(removedAt ? { removedAt: removedAt.toISOString() } : {}),
        },
        idempotencyKey: key,
      });
      if (response.status !== 201 && response.status !== 200)
        return refusal(response, `the removal of ${email}`, "record");
      return {
        removal: removalFromWire((await response.json()) as WireRemoval),
        created: response.status === 201,
      };
    },

    async getRemoval(email: string): Promise<Removal | null> {
      const response = await request("GET", removalPath(email));
      if (response.status === 404) return null;
      if (response.status !== 200)
        return refusal(response, `the removal of ${email}`, "read");
      return removalFromWire((await response.json()) as WireRemoval);
    },

    /** The removals among these addresses (at most 200 per call). */
    async removalsAmong(emails: readonly string[]): Promise<Removal[]> {
      const found: Removal[] = [];
      const unique = [...new Set(emails.map(normalizeEmail))];
      for (let start = 0; start < unique.length; start += 200) {
        const query = new URLSearchParams({ limit: "200" });
        for (const email of unique.slice(start, start + 200))
          query.append("email", email);
        const response = await request(
          "GET",
          `/api/directory/removals?${query}`,
        );
        if (response.status !== 200)
          return refusal(response, "removals", "list");
        const body = (await response.json()) as { removals: WireRemoval[] };
        found.push(...body.removals.map(removalFromWire));
      }
      return found;
    },

    async allRemovals(): Promise<Removal[]> {
      const removals: Removal[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ limit: "200" });
        if (cursor) query.set("cursor", cursor);
        const response = await request(
          "GET",
          `/api/directory/removals?${query}`,
        );
        if (response.status !== 200)
          return refusal(response, "removals", "list");
        const body = (await response.json()) as {
          removals: WireRemoval[];
          nextCursor: string | null;
        };
        removals.push(...body.removals.map(removalFromWire));
        cursor = body.nextCursor;
      } while (cursor);
      return removals;
    },

    /** Lift a removal. With `version`, only the removal that was read: a newer one stays. */
    async deleteRemoval(
      email: string,
      key: string,
      version?: number,
    ): Promise<boolean> {
      const response = await request("DELETE", removalPath(email), {
        idempotencyKey: key,
        ...(version === undefined ? {} : { ifMatch: version }),
      });
      if (response.status === 404) return false;
      if (response.status !== 204)
        return refusal(response, `the removal of ${email}`, "lift");
      return true;
    },

    async linkIdentity(
      link: {
        userId: string;
        provider: string;
        realm: string;
        subject: string;
        verifiedBy: "challenge" | "oauth";
        handle?: string | null;
        credentialId?: string;
        createdAt?: Date;
      },
      key: string,
    ): Promise<IdentityWrite> {
      const response = await request("POST", "/api/directory/identities/link", {
        body: {
          personId: link.userId,
          provider: link.provider,
          realm: link.realm,
          subject: link.subject,
          verifiedBy: link.verifiedBy,
          ...(link.handle === undefined ? {} : { handle: link.handle }),
          ...(link.credentialId === undefined
            ? {}
            : { credentialRef: link.credentialId }),
          ...(link.createdAt
            ? { createdAt: link.createdAt.toISOString() }
            : {}),
        },
        idempotencyKey: key,
      });
      if (response.status !== 200 && response.status !== 201)
        return refusal(response, `person ${link.userId}`, "link an account to");
      return identityWriteFrom(response);
    },

    async listIdentities(filter: {
      userId?: string;
      provider?: string;
      realm?: string;
      subject?: string;
    }): Promise<LinkedIdentityRecord[]> {
      const identities: LinkedIdentityRecord[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ limit: "200" });
        if (filter.userId) query.set("personId", filter.userId);
        if (filter.provider) query.set("provider", filter.provider);
        if (filter.realm) query.set("realm", filter.realm);
        if (filter.subject) query.set("subject", filter.subject);
        if (cursor) query.set("cursor", cursor);
        const response = await request(
          "GET",
          `/api/directory/identities?${query}`,
        );
        if (response.status !== 200)
          return refusal(response, "linked accounts", "list");
        const body = (await response.json()) as {
          identities: WireIdentity[];
          nextCursor: string | null;
        };
        identities.push(...body.identities.map(identityFromWire));
        cursor = body.nextCursor;
      } while (cursor);
      return identities;
    },

    async getIdentity(id: string): Promise<LinkedIdentityRecord | null> {
      const response = await request("GET", identityPath(id));
      if (response.status === 404) return null;
      if (response.status !== 200)
        return refusal(response, `linked account ${id}`, "read");
      return identityFromWire((await response.json()) as WireIdentity);
    },

    async updateIdentity(
      id: string,
      changes: {
        status?: "active" | "needs_reconnect";
        credentialId?: string | null;
      },
      key: string,
      version?: number,
    ): Promise<IdentityWrite | null> {
      const response = await request("PATCH", identityPath(id), {
        body: {
          ...(changes.status ? { status: changes.status } : {}),
          ...(changes.credentialId === undefined
            ? {}
            : { credentialRef: changes.credentialId }),
        },
        idempotencyKey: key,
        ...(version === undefined ? {} : { ifMatch: version }),
      });
      if (response.status === 404) return null;
      if (response.status !== 200)
        return refusal(response, `linked account ${id}`, "change");
      return identityWriteFrom(response);
    },

    /** Unlink one of `userId`'s accounts. Null when they have no such link. */
    async unlinkIdentity(
      userId: string,
      id: string,
      key: string,
    ): Promise<IdentityWrite | null> {
      const query = new URLSearchParams({ personId: userId });
      const response = await request("DELETE", `${identityPath(id)}?${query}`, {
        idempotencyKey: key,
      });
      if (response.status === 404) return null;
      if (response.status !== 200)
        return refusal(response, `linked account ${id}`, "unlink");
      return identityWriteFrom(response);
    },

    async putIdentityProvider(
      provider: {
        providerId: string;
        issuer: string;
        domain: string;
        protocol: "oidc" | "saml";
        registeredBy: string | null;
        createdAt?: Date;
      },
      key: string,
    ): Promise<IdentityProviderRecord> {
      const response = await request(
        "PUT",
        identityProviderPath(provider.providerId),
        {
          body: {
            issuer: provider.issuer,
            domain: provider.domain,
            protocol: provider.protocol,
            registeredBy: provider.registeredBy,
            ...(provider.createdAt
              ? { createdAt: provider.createdAt.toISOString() }
              : {}),
          },
          idempotencyKey: key,
        },
      );
      if (response.status !== 201 && response.status !== 200)
        return refusal(
          response,
          `identity provider ${provider.providerId}`,
          "record",
        );
      return identityProviderFromWire(
        (await response.json()) as WireIdentityProvider,
      );
    },

    async allIdentityProviders(): Promise<IdentityProviderRecord[]> {
      const providers: IdentityProviderRecord[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ limit: "200" });
        if (cursor) query.set("cursor", cursor);
        const response = await request(
          "GET",
          `/api/directory/identity-providers?${query}`,
        );
        if (response.status !== 200)
          return refusal(response, "identity providers", "list");
        const body = (await response.json()) as {
          identityProviders: WireIdentityProvider[];
          nextCursor: string | null;
        };
        providers.push(...body.identityProviders.map(identityProviderFromWire));
        cursor = body.nextCursor;
      } while (cursor);
      return providers;
    },

    /** True when this call removed it, false when there was none. */
    async deleteIdentityProvider(
      providerId: string,
      key: string,
    ): Promise<boolean> {
      const response = await request(
        "DELETE",
        identityProviderPath(providerId),
        {
          idempotencyKey: key,
        },
      );
      if (response.status === 404) return false;
      if (response.status !== 204)
        return refusal(response, `identity provider ${providerId}`, "remove");
      return true;
    },
  };
  return client;
}

async function identityWriteFrom(response: Response): Promise<IdentityWrite> {
  const body = (await response.json()) as {
    identity: WireIdentity;
    released?: string[];
  };
  return {
    identity: identityFromWire(body.identity),
    released: body.released ?? [],
  };
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown };
    };
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

function pause(attempt: number) {
  return new Promise((resolve) => setTimeout(resolve, 150 * attempt * attempt));
}

/** Parses one `directory_changed` announcement, or null for anything else. */
export function parseDirectoryChange(payload: unknown): DirectoryChange | null {
  if (!payload || typeof payload !== "object") return null;
  const { kind, id, personId, version, change } = payload as Record<
    string,
    unknown
  >;
  if (
    kind !== "person" &&
    kind !== "identity" &&
    kind !== "removal" &&
    kind !== "identity_provider"
  )
    return null;
  if (typeof id !== "string" || typeof version !== "number") return null;
  if (
    change !== "created" &&
    change !== "updated" &&
    change !== "deleted" &&
    change !== "restored" &&
    change !== "purged"
  )
    return null;
  return {
    kind,
    id,
    personId: typeof personId === "string" ? personId : null,
    version,
    change,
  };
}
