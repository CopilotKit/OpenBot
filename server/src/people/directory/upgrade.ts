/**
 * Moving an existing deployment's people into Intelligence's organization directory, once, at boot.
 *
 * A deployment that ran before this release holds its people in `users` and `user_roles`, the addresses
 * it removed in `revoked_access`, its people's linked outside accounts in `identity_links` and its
 * registered identity providers in `sso_providers`. This copies all of it into the directory with the
 * ids, roles, preferences, onboarding, timestamps and removals it had, checks that the directory holds
 * every one, and only then records the copy as done.
 *
 * People are copied by pushing them: the migration that added `users.directory_version` left every
 * existing row pending, so the same push that carries a first sign-in carries them. A person's role is
 * the one the migration copied onto the row from `user_roles`.
 *
 * SAFE TO RUN ANY NUMBER OF TIMES, FROM ANY NUMBER OF REPLICAS AT ONCE. Every write is keyed by a hash of
 * the request, made only from the local rows, so two replicas copying the same record send the same
 * request and Intelligence answers the second with the first's result. A record the directory already
 * holds is left alone.
 *
 * LOUD ON A MISMATCH. A record Intelligence refuses, or one missing after the copy, stops the boot with
 * what is missing named. Running on with some people copied and some not would sign people in as
 * strangers and say nothing about why.
 */
import { createHash } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  identityLinks,
  intelligenceCopies,
  revokedAccess,
  ssoProviders,
  users,
} from "../../db/schema";
import { idempotencyKey, normalizeEmail } from "./client";
import type { PeopleDirectory } from "./directory";

export const PEOPLE_COPY_NAME = "people";

export class PeopleCopyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeopleCopyMismatchError";
  }
}

export type PeopleCopyOutcome =
  | { kind: "done-before" }
  | {
      kind: "copied";
      people: number;
      removals: number;
      identities: number;
      identityProviders: number;
    };

const keyFor = (kind: string, body: unknown) =>
  `openbot-upgrade:${kind}:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;

export async function copyLocalPeopleToIntelligence(
  database: Database,
  directory: Pick<PeopleDirectory, "client" | "pushPending">,
): Promise<PeopleCopyOutcome> {
  const [done] = await database
    .select({ name: intelligenceCopies.name })
    .from(intelligenceCopies)
    .where(eq(intelligenceCopies.name, PEOPLE_COPY_NAME))
    .limit(1);
  if (done) return { kind: "done-before" };

  const { client } = directory;

  // People: every pending row is pushed, in batches, until none is left or a batch moves nothing. A
  // row with a version came from Intelligence and is there already (or was purged, which the
  // directory's full read deals with), so the pending rows are what is copied.
  const local = await database
    .select({ id: users.id })
    .from(users)
    .where(isNull(users.directoryVersion));
  for (;;) {
    const pending = await database
      .select({ id: users.id })
      .from(users)
      .where(isNull(users.directoryVersion))
      .limit(1);
    if (pending.length === 0) break;
    if ((await directory.pushPending(200)) === 0) break;
  }
  const stuck = await database
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(isNull(users.directoryVersion));
  if (stuck.length > 0) {
    throw new PeopleCopyMismatchError(
      `Intelligence's directory did not take ${stuck.length} of this deployment's ${local.length} people, so this server will not start without them (each refusal is logged as directory-push-failed or directory-push-email-taken): ${stuck.map((row) => row.id).join(", ")}`,
    );
  }
  const { people } = await client.allPeople({ includeDeleted: true });
  const present = new Set(people.map((person) => person.id));
  const missingPeople = local.filter((row) => !present.has(row.id));
  if (missingPeople.length > 0) {
    throw new PeopleCopyMismatchError(
      `${local.length} people were to be copied into Intelligence and ${local.length - missingPeople.length} are there. Missing: ${missingPeople.map((row) => row.id).join(", ")}`,
    );
  }

  // Removed addresses, with who removed them and when.
  const removals = await database.select().from(revokedAccess);
  const putRemovals = async (rows: typeof removals, fresh: boolean) => {
    for (const row of rows) {
      const body = {
        email: normalizeEmail(row.email),
        removedBy: row.revokedBy,
        removedAt: row.revokedAt.toISOString(),
      };
      await client.putRemoval(
        body.email,
        row.revokedBy,
        fresh ? idempotencyKey("copy-removal") : keyFor("removal", body),
        row.revokedAt,
      );
    }
  };
  const missingRemovalsOf = async () => {
    const there = new Set(
      (await client.allRemovals()).map((removal) => removal.email),
    );
    return removals.filter((row) => !there.has(normalizeEmail(row.email)));
  };
  await putRemovals(removals, false);
  let missingRemovals = await missingRemovalsOf();
  // A key made from the request is answered from Intelligence's receipt for a day; a record removed
  // there since then was not made again by it. Those go once more, under keys of their own.
  if (missingRemovals.length > 0) {
    await putRemovals(missingRemovals, true);
    missingRemovals = await missingRemovalsOf();
  }
  if (missingRemovals.length > 0) {
    throw new PeopleCopyMismatchError(
      `${removals.length} removed addresses were to be copied into Intelligence and ${removals.length - missingRemovals.length} are there. Missing: ${missingRemovals.map((row) => row.email).join(", ")}`,
    );
  }

  // Linked outside accounts. A link whose person is gone has nobody to belong to in the directory; it
  // was only ever kept so the account resolved to a removed person rather than to a guest, and the
  // directory refuses an unknown account the same way. Said, not dropped quietly.
  const links = await database.select().from(identityLinks);
  const orphaned = links.filter((link) => !present.has(link.userId));
  if (orphaned.length > 0) {
    console.warn(
      JSON.stringify({
        type: "identity-link-copy-skipped-orphaned",
        note: "These linked accounts belong to people this deployment no longer has, and are not copied.",
        links: orphaned.map((link) => link.id),
      }),
    );
  }
  const copied = links.filter((link) => present.has(link.userId));
  const linkKey = (link: {
    provider: string;
    realm: string;
    subject: string;
    userId: string;
  }) =>
    `${link.provider}\u001f${link.realm}\u001f${link.subject}\u001f${link.userId}`;
  const linkedThere = async () =>
    new Set((await client.listIdentities({})).map(linkKey));
  const writeLinks = async (rows: typeof copied, fresh: boolean) => {
    const held = await linkedThere();
    for (const link of rows) {
      if (held.has(linkKey(link))) continue;
      const body = {
        userId: link.userId,
        provider: link.provider,
        realm: link.realm,
        subject: link.subject,
        verifiedBy: link.verifiedBy,
        handle: link.handle,
        ...(link.credentialId ? { credentialId: link.credentialId } : {}),
        createdAt: link.createdAt,
      };
      const written = await client.linkIdentity(
        body,
        fresh ? idempotencyKey("copy-identity") : keyFor("identity", body),
      );
      // A link that needed reconnecting still does.
      if (
        link.status === "needs_reconnect" &&
        written.identity.status !== link.status
      )
        await client.updateIdentity(
          written.identity.id,
          { status: "needs_reconnect" },
          idempotencyKey("copy-identity-status"),
        );
    }
  };
  const missingLinksOf = async () => {
    const there = await linkedThere();
    return copied.filter((link) => !there.has(linkKey(link)));
  };
  await writeLinks(copied, false);
  let missingLinks = await missingLinksOf();
  if (missingLinks.length > 0) {
    await writeLinks(missingLinks, true);
    missingLinks = await missingLinksOf();
  }
  if (missingLinks.length > 0) {
    throw new PeopleCopyMismatchError(
      `${copied.length} linked accounts were to be copied into Intelligence and ${copied.length - missingLinks.length} are there. Missing: ${missingLinks.map((link) => link.id).join(", ")}`,
    );
  }

  // Registered identity providers: what describes each. Their secrets stay in `sso_providers`.
  const providers = await database.select().from(ssoProviders);
  const describeProviders = async (rows: typeof providers, fresh: boolean) => {
    for (const row of rows) {
      const body = {
        providerId: row.providerId,
        issuer: row.issuer,
        domain: row.domain.toLowerCase(),
        protocol: row.samlConfig ? ("saml" as const) : ("oidc" as const),
        registeredBy: row.userId,
      };
      await client.putIdentityProvider(
        body,
        fresh
          ? idempotencyKey("copy-identity-provider")
          : keyFor("identity-provider", body),
      );
    }
  };
  const missingProvidersOf = async () => {
    const there = new Set(
      (await client.allIdentityProviders()).map(
        (provider) => provider.providerId,
      ),
    );
    return providers.filter((row) => !there.has(row.providerId));
  };
  await describeProviders(providers, false);
  let missingProviders = await missingProvidersOf();
  if (missingProviders.length > 0) {
    await describeProviders(missingProviders, true);
    missingProviders = await missingProvidersOf();
  }
  if (missingProviders.length > 0) {
    throw new PeopleCopyMismatchError(
      `${providers.length} identity providers were to be copied into Intelligence and ${providers.length - missingProviders.length} are there. Missing: ${missingProviders.map((row) => row.providerId).join(", ")}`,
    );
  }

  await database
    .insert(intelligenceCopies)
    .values({ name: PEOPLE_COPY_NAME, copied: local.length })
    .onConflictDoNothing();
  console.info(
    JSON.stringify({
      type: "people-copied-to-intelligence",
      people: local.length,
      removals: removals.length,
      identities: copied.length,
      identityProviders: providers.length,
    }),
  );
  return {
    kind: "copied",
    people: local.length,
    removals: removals.length,
    identities: copied.length,
    identityProviders: providers.length,
  };
}
